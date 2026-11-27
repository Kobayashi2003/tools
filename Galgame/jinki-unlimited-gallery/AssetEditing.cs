using System.Reflection;
using UAssetAPI;
using UAssetAPI.ExportTypes;
using UAssetAPI.FieldTypes;
using UAssetAPI.Kismet.Bytecode;
using UAssetAPI.Kismet.Bytecode.Expressions;
using UAssetAPI.PropertyTypes.Objects;
using UAssetAPI.PropertyTypes.Structs;
using UAssetAPI.UnrealTypes;

namespace JinkiUnlimited.Gallery;

internal static partial class GalleryPatch
{
    private static UAsset LoadAsset(string path) => new(path, EngineVersion.VER_UE4_27);

    private static void WriteAsset(UAsset asset, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        asset.Write(path);
    }

    private static FPackageIndex ImportIndex(UAsset asset, string name, bool required = true)
    {
        var index = asset.Imports.FindIndex(x => x.ObjectName.ToString() == name);
        if (index < 0 && required) throw new InvalidDataException($"Cannot resolve {name}");
        return new FPackageIndex(-index - 1);
    }

    private static FPackageIndex AddImport(UAsset asset, string classPackage, string className, string package, string name)
    {
        var outer = ImportIndex(asset, package, required: false);
        if (outer.Index == 0)
        {
            asset.Imports.Add(new Import("/Script/CoreUObject", "Package", new FPackageIndex(0), package, false, asset));
            outer = new FPackageIndex(-asset.Imports.Count);
        }
        asset.Imports.Add(new Import(classPackage, className, outer, name, false, asset));
        return new FPackageIndex(-asset.Imports.Count);
    }

    private static FPackageIndex AddFunctionImport(UAsset asset, FPackageIndex owner, string name)
    {
        asset.Imports.Add(new Import("/Script/CoreUObject", "Function", owner, name, false, asset));
        return new FPackageIndex(-asset.Imports.Count);
    }

    private static FPackageIndex GetFunctionImport(UAsset asset, FPackageIndex owner, string name)
    {
        var i = asset.Imports.FindIndex(x => x.OuterIndex.Index == owner.Index && x.ObjectName.ToString() == name);
        return i < 0 ? AddFunctionImport(asset, owner, name) : new FPackageIndex(-i - 1);
    }

    private static EX_InstanceVariable FieldVariable(FName field, FPackageIndex owner) => new()
    {
        Variable = new KismetPropertyPointer { New = new FFieldPath { Path = new[] { field }, ResolvedOwner = owner } },
    };

    private static FProperty CloneField(ClassExport owner, FName source, FName name)
    {
        var property = owner.LoadedProperties.Single(x => x.Name == source);
        var clone = (FProperty)typeof(object).GetMethod("MemberwiseClone", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(property, null)!;
        clone.Name = name;
        return clone;
    }

    private static T CloneExport<T>(UAsset asset, T source, string name, Dictionary<int, FPackageIndex> added) where T : NormalExport
    {
        var clone = (T)source.Clone();
        clone.ObjectName = new FName(asset, name);
        clone.Data = source.Data.Select(CloneProperty).ToList();
        asset.Exports.Add(clone);
        added.Add(IndexOf(asset, source).Index, IndexOf(asset, clone));
        asset.DependsMap.Add(asset.DependsMap[IndexOf(asset, source).Index - 1].ToArray());
        return clone;
    }

    private static PropertyData CloneProperty(PropertyData source)
    {
        var clone = (PropertyData)source.Clone();
        // ArrayPropertyData.Clone can retain references to the source elements.
        switch (clone)
        {
            case ArrayPropertyData array:
                array.Value = ((ArrayPropertyData)source).Value.Select(CloneProperty).ToArray();
                break;
            case StructPropertyData structure:
                structure.Value = ((StructPropertyData)source).Value.Select(CloneProperty).ToList();
                break;
        }
        return clone;
    }

    private static void RemapExport(UAsset asset, Export e, IReadOnlyDictionary<int, FPackageIndex> added)
    {
        FPackageIndex Map(FPackageIndex p) => added.TryGetValue(p.Index, out var mapped) ? mapped : p;
        e.OuterIndex = Map(e.OuterIndex);
        e.TemplateIndex = Map(e.TemplateIndex);
        e.SerializationBeforeSerializationDependencies = e.SerializationBeforeSerializationDependencies.Select(Map).ToList();
        e.CreateBeforeSerializationDependencies = e.CreateBeforeSerializationDependencies.Select(Map).ToList();
        e.SerializationBeforeCreateDependencies = e.SerializationBeforeCreateDependencies.Select(Map).ToList();
        e.CreateBeforeCreateDependencies = e.CreateBeforeCreateDependencies.Select(Map).ToList();
        asset.DependsMap[IndexOf(asset, e).Index - 1] = asset.DependsMap[IndexOf(asset, e).Index - 1]
            .Select(x => Map(new FPackageIndex(x)).Index).ToArray();
        foreach (var prop in ((NormalExport)e).Data)
            RemapProperty(prop);

        void RemapProperty(PropertyData property)
        {
            switch (property)
            {
                case ObjectPropertyData obj:
                    obj.Value = Map(obj.Value);
                    break;
                case ArrayPropertyData arr:
                    foreach (var item in arr.Value) RemapProperty(item);
                    break;
                case StructPropertyData structure:
                    foreach (var item in structure.Value) RemapProperty(item);
                    break;
            }
        }
    }

    private static PropertyData Property(NormalExport export, string name) =>
        export.Data.Single(x => x.Name.ToString() == name);

    private static T FindProperty<T>(PropertyData source, string name) where T : PropertyData =>
        Properties(source).OfType<T>().Single(x => x.Name.ToString() == name);

    private static IEnumerable<PropertyData> Properties(PropertyData source)
    {
        yield return source;
        if (source is StructPropertyData structure)
            foreach (var property in structure.Value.SelectMany(Properties)) yield return property;
    }

    private static NormalExport ObjectTarget(UAsset asset, NormalExport source, string name) =>
        (NormalExport)((ObjectPropertyData)Property(source, name)).Value.ToExport(asset);

    private static T Get<T>(UAsset asset, string name) where T : Export =>
        asset.Exports.OfType<T>().Single(x => x.ObjectName.ToString() == name);

    private static FPackageIndex IndexOf(UAsset asset, Export e) => new(asset.Exports.IndexOf(e) + 1);

    private static KismetExpression At(UAsset asset, FunctionExport graph, uint address)
    {
        var offset = 0u;
        foreach (var node in graph.ScriptBytecode)
        {
            if (offset == address) return node;
            offset += node.GetSize(asset);
        }
        throw new InvalidDataException($"No statement at Blueprint address {address:X}");
    }

    private static void ReplaceWithJump(UAsset asset, FunctionExport graph, uint address, params KismetExpression[] block)
    {
        var previous = At(asset, graph, address);
        var size = previous.GetSize(asset);
        var end = graph.ScriptBytecode.Last();
        if (size < 5 || end is not EX_EndOfScript || At(asset, graph, address + size) == end)
            throw new InvalidDataException("The function layout cannot accommodate a jump");

        var newAddress = EndOfBody(asset, graph);
        var body = graph.ScriptBytecode.ToList();
        var position = body.IndexOf(previous);
        body.RemoveAt(position);
        body.Insert(position, new EX_Jump { CodeOffset = newAddress });
        body.InsertRange(position + 1, Enumerable.Range(0, (int)size - 5).Select(_ => new EX_Nothing()));
        body.InsertRange(body.Count - 1, block.Append(new EX_Jump { CodeOffset = address + size }));
        graph.ScriptBytecode = body.ToArray();
    }

    private static uint EndOfBody(UAsset asset, FunctionExport graph) => graph.ScriptBytecode.Take(graph.ScriptBytecode.Length - 1)
        .Aggregate(0u, (total, expr) => total + expr.GetSize(asset));
}
