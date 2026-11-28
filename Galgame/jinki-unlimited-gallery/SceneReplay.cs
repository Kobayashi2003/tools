using System.Text;
using UAssetAPI;
using UAssetAPI.ExportTypes;
using UAssetAPI.Kismet.Bytecode;
using UAssetAPI.Kismet.Bytecode.Expressions;
using UAssetAPI.PropertyTypes.Objects;
using UAssetAPI.PropertyTypes.Structs;
using UAssetAPI.UnrealTypes;

namespace JinkiUnlimited.Gallery;

internal static partial class GalleryPatch
{
    private static void PatchSceneList(UAsset asset)
    {
        var catalog = AddImport(asset, "/Script/Engine", "DataTable", "/Game/JinkiGallery/DT_Replay", "DT_Replay");
        var thumbnails = AddImport(asset, "/Script/Engine", "DataTable", "/Game/JinkiGallery/DT_Texture", "DT_Texture");
        var list = Get<FunctionExport>(asset, "OpenRecolectionFuction");
        var names = (EX_CallMath)At(asset, list, 0xE0);
        var start = (EX_CallMath)At(asset, list, 0x442);
        var unlock = (EX_CallMath)At(asset, list, 0x419);
        ReplaceWithJump(asset, list, 0xE0, new EX_CallMath
        {
            StackNode = names.StackNode,
            Parameters = new KismetExpression[] { new EX_ObjectConst { Value = catalog }, names.Parameters[1] },
        });
        ReplaceTable(0x227, catalog);
        ReplaceTable(0x328, thumbnails);
        // These entries play self-contained replay copies from the beginning.
        ReplaceWithJump(asset, list, 0x419, new EX_CallMath
        {
            StackNode = unlock.StackNode,
            Parameters = new[] { unlock.Parameters[0], unlock.Parameters[1], new EX_True() },
        });
        ReplaceWithJump(asset, list, 0x442, new EX_CallMath
        {
            StackNode = start.StackNode,
            Parameters = new[] { start.Parameters[0], start.Parameters[1], new EX_IntConst { Value = 0 } },
        });
        list.SerializationBeforeSerializationDependencies.AddRange(new[] { catalog, thumbnails });

        void ReplaceTable(uint offset, FPackageIndex table)
        {
            var original = (EX_LetBool)At(asset, list, offset);
            var context = (EX_Context)original.AssignmentExpression;
            var getRow = (EX_FinalFunction)context.ContextExpression;
            var call = new EX_FinalFunction
            {
                StackNode = getRow.StackNode,
                Parameters = new[] { new EX_ObjectConst { Value = table }, getRow.Parameters[1], getRow.Parameters[2] },
            };
            ReplaceWithJump(asset, list, offset, new EX_LetBool
            {
                VariableExpression = original.VariableExpression,
                AssignmentExpression = new EX_Context
                {
                    ObjectExpression = context.ObjectExpression,
                    ContextExpression = call,
                    RValuePointer = context.RValuePointer,
                    Offset = call.GetSize(asset),
                },
            });
        }
    }

    private static void PatchSaveGuards(UAsset asset)
    {
        var instance = Get<ClassExport>(asset, "VNInstanceObject_C");
        var flag = FieldVariable(new FName(asset, "SceneGalleryFlag"), IndexOf(asset, instance));
        foreach (var name in new[] { "Save Event", "Save Save Slot Data", "Save_GlobalSaveData",
            "Save_GlobalData_forFlag", "Set_Texture_Flag", "Start_Delete_SaveSlot" })
        {
            var function = Get<FunctionExport>(asset, name);
            var original = At(asset, function, 0);
            var branch = new EX_JumpIfNot { BooleanExpression = flag };
            var stop = new EX_Return { ReturnExpression = new EX_Nothing() };
            branch.CodeOffset = EndOfBody(asset, function) + branch.GetSize(asset) + stop.GetSize(asset);
            ReplaceWithJump(asset, function, 0, branch, stop, original);
        }
    }

    private static void PatchReplayMouseCapture(UAsset asset)
    {
        var graph = Get<FunctionExport>(asset, "ExecuteUbergraph_BP_TrexGameMode");
        const uint captureOffset = 0x4D0F;
        var original = (EX_CallMath)At(asset, graph, captureOffset);
        if (original.StackNode.ToImport(asset).ObjectName.ToString() != "SetViewportMouseCaptureMode"
            || original.Parameters is not [EX_Self, EX_ByteConst { Value: 1 }])
            throw new InvalidDataException("Unexpected game mode mouse capture instruction");

        var subsystemClass = ImportIndex(asset, "VNGameInstanceSubsystem");
        var instanceClass = ImportIndex(asset, "VNInstanceObject_C");
        var subsystem = new EX_CallMath
        {
            StackNode = ImportIndex(asset, "GetGameInstanceSubsystem"),
            Parameters = new KismetExpression[] { new EX_Self(), new EX_ObjectConst { Value = subsystemClass } },
        };
        var instance = new EX_DynamicCast
        {
            ClassPtr = instanceClass,
            Target = ReadField(subsystem, "VNObject", subsystemClass),
        };
        var useOriginalMode = new EX_JumpIfNot
        {
            BooleanExpression = ReadField(instance, "SceneGalleryFlag", instanceClass),
        };
        // CapturePermanently_IncludingInitialMouseDown delivers the press that takes capture.
        var replayMode = new EX_CallMath
        {
            StackNode = original.StackNode,
            Parameters = new KismetExpression[] { original.Parameters[0], new EX_ByteConst { Value = 2 } },
        };
        var afterCapture = new EX_Jump { CodeOffset = captureOffset + original.GetSize(asset) };
        useOriginalMode.CodeOffset = EndOfBody(asset, graph) + useOriginalMode.GetSize(asset)
            + replayMode.GetSize(asset) + afterCapture.GetSize(asset);
        ReplaceWithJump(asset, graph, captureOffset, useOriginalMode, replayMode, afterCapture, original);

        EX_Context ReadField(KismetExpression context, string name, FPackageIndex owner)
        {
            var field = FieldVariable(new FName(asset, name), owner);
            return new EX_Context
            {
                ObjectExpression = context,
                ContextExpression = field,
                RValuePointer = field.Variable,
                Offset = field.GetSize(asset),
            };
        }
    }

    private static void BuildSceneCatalog(string extracted, string output)
    {
        const string originalPrefix = "/Game/T_Rex/DataTable/Script/";
        const string replayPrefix = "/Game/JinkiGallery/Scenes/";
        const string defeatPrefix = originalPrefix + "D01_01/";
        const string eventCgPrefix = "/Game/T_Rex/Texture/EventCG/";
        var catalog = LoadAsset(Path.Combine(extracted, VnContent + "DataTable/Script/setting/DT_Replay.uasset"));
        var rows = catalog.Exports.OfType<DataTableExport>().Single().Table.Data;
        // The game's D01 scripts form the defeat arc. A jump to another indexed
        // episode is the end of the current standalone replay.
        var defeatEntries = rows.Select(x => Field<StrPropertyData>(x, "ReplaySinarioLabel").Value?.Value)
            .OfType<string>()
            .Where(x => x.StartsWith("*" + defeatPrefix, StringComparison.Ordinal))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var story = LoadAsset(Path.Combine(extracted, GameContent + "T_Rex/DataTable/DataTable/DT_Story_Master.uasset"));
        var titles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in story.Exports.OfType<DataTableExport>().Single().Table.Data)
        {
            var reference = Field<StrPropertyData>(row, "ScriptFile").Value?.Value;
            var name = Field<StrPropertyData>(row, "Story").Value?.Value;
            if (!string.IsNullOrWhiteSpace(reference) && !string.IsNullOrWhiteSpace(name))
                titles.TryAdd(reference, name);
        }
        var selected = new List<StructPropertyData>();
        var seenScripts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var thumbnails = LoadAsset(Path.Combine(extracted, VnContent + "DataTable/Script/setting/DT_Texture.uasset"));
        var textures = thumbnails.Exports.OfType<DataTableExport>().Single().Table.Data;
        var eventCgNames = textures
            .Where(x => Field<SoftObjectPropertyData>(x, "2Dtexture").Value.AssetPath.AssetName.ToString()
                .StartsWith(eventCgPrefix, StringComparison.OrdinalIgnoreCase))
            .Select(x => x.Name.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var usedTextures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var allowed = new HashSet<string>(new[] { "Wait", "CharacterOff", "MessageWindowSetting", "Sound", "Texture",
            "FadeOut", "FadeIn", "StopSound", "TextureOff", "PostProcessEffect", "PostProcessEffectOff",
            "Movie", "HideLoading", "Character", "StopVoice", "Transition" }, StringComparer.OrdinalIgnoreCase);
        var terminal = new HashSet<string>(new[] { "BackToBattle", "EndScenario", "OpenSortieMap", "BeginBattle" }, StringComparer.OrdinalIgnoreCase);
        Console.WriteLine("Scene\tScript\tCategory\tTitle\tThumbnail");
        foreach (var row in rows)
        {
            var label = Field<StrPropertyData>(row, "ReplaySinarioLabel");
            if (label.Value?.Value is not { } originalLabel || !defeatEntries.Contains(originalLabel)) continue;
            var target = originalLabel.Split('*', StringSplitOptions.RemoveEmptyEntries);
            if (target is not [var objectPath, "labelA"] || !objectPath.StartsWith(originalPrefix, StringComparison.Ordinal)) continue;
            var parts = objectPath[originalPrefix.Length..].Split('.');
            if (parts.Length != 2 || Path.GetFileName(parts[0]) != parts[1] || parts[0].Split('/').Any(x => x == "..")) continue;
            var name = titles.GetValueOrDefault(originalLabel, parts[1]);
            var relative = parts[0] + ".uasset";
            var input = Path.Combine(extracted, GameContent + "T_Rex/DataTable/Script/" + relative);
            if (!File.Exists(input) || !seenScripts.Add(relative)) continue;
            var scene = LoadAsset(input);
            var sceneTable = scene.Exports.OfType<DataTableExport>().Single();
            var sceneRows = sceneTable.Table.Data;
            var commands = sceneRows.Select(x => Field<StrPropertyData>(x, "Command").Value?.Value ?? "").ToArray();
            var end = Array.FindIndex(commands, terminal.Contains);
            var jump = Array.FindIndex(commands, x => x.Equals("Jump", StringComparison.OrdinalIgnoreCase));
            if (jump > 0 && (end < 0 || jump < end) &&
                Field<StrPropertyData>(sceneRows[jump], "Arg1").Value?.Value is { } next &&
                defeatEntries.Contains(next) && !next.Equals(originalLabel, StringComparison.OrdinalIgnoreCase))
                end = jump;
            bool safe = end > 0 && commands[0] == "*labelA" && commands.Take(end).All(x =>
                x == "" || x.StartsWith("//", StringComparison.Ordinal) || x.StartsWith('*') || allowed.Contains(x));
            if (!safe || !sceneRows.Take(end).Any(x => Field<TextPropertyData>(x, "TEXT").Value?.Value is { Length: > 0 })) continue;

            var firstCg = Enumerable.Range(0, end)
                .Where(i => commands[i].Equals("Texture", StringComparison.OrdinalIgnoreCase))
                .Select(i => Field<StrPropertyData>(sceneRows[i], "Arg1").Value?.Value)
                .OfType<string>()
                .FirstOrDefault(eventCgNames.Contains);
            if (firstCg is null) continue;

            Field<StrPropertyData>(sceneRows[end], "Command").Value = new FString("EndSceneGallery");
            sceneRows.RemoveRange(end + 1, sceneRows.Count - end - 1);
            var newName = "GalleryScene_" + parts[1];
            sceneTable.ObjectName = new FName(scene, newName);
            var folder = string.Join('/', parts[0].Split('/').SkipLast(1));
            var replay = $"{folder}/{newName}";
            WriteAsset(scene, Path.Combine(output, PatchContent + "Scenes/" + replay + ".uasset"));
            var display = $"{row.Name}  {name.Replace('*', ' ').Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ')}";
            usedTextures.Add(firstCg);
            Field<StrPropertyData>(row, "List_Texture").Value = new FString(firstCg);
            label.Value = new FString($"*{replayPrefix}{replay}.{newName}*{display}", Encoding.Unicode);
            selected.Add(row);
            Console.WriteLine($"{row.Name}\t{parts[1]}\tDefeat\t{name}\t{firstCg}");
        }
        if (selected.Count == 0) throw new InvalidDataException("The replay catalog is empty");
        rows.Clear();
        rows.AddRange(selected);
        WriteAsset(catalog, Path.Combine(output, PatchContent + "DT_Replay.uasset"));

        textures.RemoveAll(x => !usedTextures.Contains(x.Name.ToString()));
        WriteAsset(thumbnails, Path.Combine(output, PatchContent + "DT_Texture.uasset"));
    }

    private static T Field<T>(StructPropertyData row, string field) where T : PropertyData =>
        row.Value.OfType<T>().Single(x => x.Name.ToString().StartsWith(field + "_", StringComparison.Ordinal));
}
