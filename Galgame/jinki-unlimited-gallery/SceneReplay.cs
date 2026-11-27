using System.Text;
using System.Text.RegularExpressions;
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
        var defeat = AddImport(asset, "/Script/Engine", "DataTable", "/Game/JinkiGallery/DT_Defeat", "DT_Defeat");
        var thumbnails = AddImport(asset, "/Script/Engine", "DataTable", "/Game/JinkiGallery/DT_Texture", "DT_Texture");
        var list = Get<FunctionExport>(asset, "OpenRecolectionFuction");
        // Save the original offsets before replacing the expressions with jumps.
        var names = (EX_CallMath)At(asset, list, 0xE0);
        var row = (EX_LetBool)At(asset, list, 0x227);
        var start = (EX_CallMath)At(asset, list, 0x442);
        var unlock = (EX_CallMath)At(asset, list, 0x419);
        SelectCatalog(0xE0, selected => new EX_CallMath
        {
            StackNode = names.StackNode,
            Parameters = new KismetExpression[] { new EX_ObjectConst { Value = selected }, names.Parameters[1] },
        });
        var context = (EX_Context)row.AssignmentExpression;
        var rowCall = (EX_FinalFunction)context.ContextExpression;
        SelectCatalog(0x227, selected =>
        {
            var patchedRowCall = new EX_FinalFunction
            {
                StackNode = rowCall.StackNode,
                Parameters = new KismetExpression[] { new EX_ObjectConst { Value = selected }, rowCall.Parameters[1], rowCall.Parameters[2] },
            };
            return new EX_LetBool
            {
                VariableExpression = row.VariableExpression,
                AssignmentExpression = new EX_Context
                {
                    ObjectExpression = context.ObjectExpression,
                    ContextExpression = patchedRowCall,
                    RValuePointer = context.RValuePointer,
                    Offset = patchedRowCall.GetSize(asset),
                },
            };
        });
        var texture = (EX_LetBool)At(asset, list, 0x328);
        var textureContext = (EX_Context)texture.AssignmentExpression;
        var textureCall = (EX_FinalFunction)textureContext.ContextExpression;
        var patchedTextureCall = new EX_FinalFunction
        {
            StackNode = textureCall.StackNode,
            Parameters = new KismetExpression[] { new EX_ObjectConst { Value = thumbnails }, textureCall.Parameters[1], textureCall.Parameters[2] },
        };
        ReplaceWithJump(asset, list, 0x328, new EX_LetBool
        {
            VariableExpression = texture.VariableExpression,
            AssignmentExpression = new EX_Context
            {
                ObjectExpression = textureContext.ObjectExpression,
                ContextExpression = patchedTextureCall,
                RValuePointer = textureContext.RValuePointer,
                Offset = patchedTextureCall.GetSize(asset),
            },
        });
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
        list.SerializationBeforeSerializationDependencies.AddRange(new[] { catalog, defeat, thumbnails });

        void SelectCatalog(uint address, Func<FPackageIndex, KismetExpression> selection)
        {
            var system = ImportIndex(asset, "KismetSystemLibrary");
            var strings = ImportIndex(asset, "KismetStringLibrary");
            var objectName = GetFunctionImport(asset, system, "GetObjectName");
            var compare = GetFunctionImport(asset, strings, "EqualEqual_StrStr");
            var condition = new EX_CallMath
            {
                StackNode = compare,
                Parameters = new KismetExpression[]
                {
                    new EX_CallMath { StackNode = objectName, Parameters = new KismetExpression[] { new EX_Self() } },
                    new EX_StringConst { Value = "W_Defeat_List" },
                },
            };
            var branch = new EX_JumpIfNot { BooleanExpression = condition };
            var selected = selection(defeat);
            var keepGoing = new EX_Jump { CodeOffset = address + At(asset, list, address).GetSize(asset) };
            branch.CodeOffset = EndOfBody(asset, list) + branch.GetSize(asset) + selected.GetSize(asset) + keepGoing.GetSize(asset);
            ReplaceWithJump(asset, list, address, branch, selected, keepGoing, selection(catalog));
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
            var blockStart = function.ScriptBytecode.Take(function.ScriptBytecode.Length - 1).Aggregate(0u, (offset, expr) => offset + expr.GetSize(asset));
            var branch = new EX_JumpIfNot { BooleanExpression = flag };
            var stop = new EX_Return { ReturnExpression = new EX_Nothing() };
            branch.CodeOffset = blockStart + branch.GetSize(asset) + stop.GetSize(asset);
            ReplaceWithJump(asset, function, 0, branch, stop, original);
        }
    }

    private static void BuildSceneCatalog(string extracted, string output)
    {
        const string originalPrefix = "/Game/T_Rex/DataTable/Script/";
        const string replayPrefix = "/Game/JinkiGallery/Scenes/";
        const string defeatPrefix = originalPrefix + "D01_01/";
        const string eventCgPrefix = "/Game/T_Rex/Texture/EventCG/";
        const string fallbackTexture = "IventStill1";
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
        var defeats = new List<StructPropertyData>();
        var ignored = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var thumbnails = LoadAsset(Path.Combine(extracted, VnContent + "DataTable/Script/setting/DT_Texture.uasset"));
        var textures = thumbnails.Exports.OfType<DataTableExport>().Single().Table.Data;
        var eventCgNames = textures
            .Where(x => Field<SoftObjectPropertyData>(x, "2Dtexture").Value.AssetPath.AssetName.ToString()
                .StartsWith(eventCgPrefix, StringComparison.OrdinalIgnoreCase))
            .Select(x => x.Name.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var usedTextures = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { fallbackTexture };
        var allowed = new HashSet<string>(new[] { "Wait", "CharacterOff", "MessageWindowSetting", "Sound", "Texture",
            "FadeOut", "FadeIn", "StopSound", "TextureOff", "PostProcessEffect", "PostProcessEffectOff",
            "Movie", "HideLoading", "Character", "StopVoice", "Transition" }, StringComparer.OrdinalIgnoreCase);
        var terminal = new HashSet<string>(new[] { "BackToBattle", "EndScenario", "OpenSortieMap", "BeginBattle" }, StringComparer.OrdinalIgnoreCase);
        var defeatTitle = new Regex("敗北|敗戦|戦敗|敗退|敗走|ゲームオーバー|敗け|負け|(?:味方|チュートリアル).*全滅|(?:作戦|任務|防衛|護衛).*失敗");
        Console.WriteLine("Scene\tScript\tCategory\tTitle\tThumbnail");
        foreach (var row in rows)
        {
            var label = Field<StrPropertyData>(row, "ReplaySinarioLabel");
            var target = label.Value?.Value?.Split('*', StringSplitOptions.RemoveEmptyEntries);
            if (target is not [var objectPath, "labelA"] || !objectPath.StartsWith(originalPrefix, StringComparison.Ordinal)) continue;
            var parts = objectPath[originalPrefix.Length..].Split('.');
            if (parts.Length != 2 || Path.GetFileName(parts[0]) != parts[1] || parts[0].Split('/').Any(x => x == "..")) continue;
            var relative = parts[0] + ".uasset";
            var input = Path.Combine(extracted, GameContent + "T_Rex/DataTable/Script/" + relative);
            if (!File.Exists(input) || !ignored.Add(relative)) continue;
            var scene = LoadAsset(input);
            var sceneRows = scene.Exports.OfType<DataTableExport>().Single().Table.Data;
            var commands = sceneRows.Select(x => Field<StrPropertyData>(x, "Command").Value?.Value ?? "").ToArray();
            var isDefeatEpisode = defeatEntries.Contains(label.Value!.Value);
            var end = Array.FindIndex(commands, terminal.Contains);
            if (isDefeatEpisode)
            {
                var jump = Array.FindIndex(commands, x => x.Equals("Jump", StringComparison.OrdinalIgnoreCase));
                if (jump > 0 && (end < 0 || jump < end) &&
                    Field<StrPropertyData>(sceneRows[jump], "Arg1").Value?.Value is { } next &&
                    defeatEntries.Contains(next) && !next.Equals(label.Value.Value, StringComparison.OrdinalIgnoreCase))
                    end = jump;
            }
            bool safe = end > 0 && commands[0] == "*labelA" && commands.Take(end).All(x =>
                x == "" || x.StartsWith("//", StringComparison.Ordinal) || x.StartsWith('*') || allowed.Contains(x));
            if (!safe || !sceneRows.Take(end).Any(x => Field<TextPropertyData>(x, "TEXT").Value?.Value is { Length: > 0 })) continue;

            Field<StrPropertyData>(sceneRows[end], "Command").Value = new FString("EndSceneGallery");
            sceneRows.RemoveRange(end + 1, sceneRows.Count - end - 1);
            var newName = "GalleryScene_" + parts[1];
            scene.Exports.OfType<DataTableExport>().Single().ObjectName = new FName(scene, newName);
            var folder = string.Join('/', parts[0].Split('/').SkipLast(1));
            var replay = $"{folder}/{newName}";
            WriteAsset(scene, Path.Combine(output, PatchContent + "Scenes/" + replay + ".uasset"));
            var originalLabel = label.Value!.Value;
            var name = titles.GetValueOrDefault(originalLabel, parts[1]);
            var display = $"{row.Name}  {name.Replace('*', ' ').Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ')}";
            string? firstCg = null;
            if (isDefeatEpisode || defeatTitle.IsMatch(name))
            {
                firstCg = Enumerable.Range(0, end)
                    .Where(i => commands[i].Equals("Texture", StringComparison.OrdinalIgnoreCase))
                    .Select(i => Field<StrPropertyData>(sceneRows[i], "Arg1").Value?.Value)
                    .OfType<string>()
                    .FirstOrDefault(eventCgNames.Contains);
            }
            var image = firstCg ?? fallbackTexture;
            usedTextures.Add(image);
            Field<StrPropertyData>(row, "List_Texture").Value = new FString(image);
            label.Value = new FString($"*{replayPrefix}{replay}.{newName}*{display}", Encoding.Unicode);
            (firstCg is null ? selected : defeats).Add(row);
            Console.WriteLine($"{row.Name}\t{parts[1]}\t{(firstCg is null ? "Scene" : "Defeat")}\t{name}\t{firstCg}");
        }
        if (selected.Count == 0 || defeats.Count == 0) throw new InvalidDataException("A replay catalog is empty");
        var table = catalog.Exports.OfType<DataTableExport>().Single();
        var data = table.Table.Data;
        data.Clear();
        data.AddRange(selected);
        WriteAsset(catalog, Path.Combine(output, PatchContent + "DT_Replay.uasset"));
        data.Clear();
        data.AddRange(defeats);
        table.ObjectName = new FName(catalog, "DT_Defeat");
        WriteAsset(catalog, Path.Combine(output, PatchContent + "DT_Defeat.uasset"));

        textures.RemoveAll(x => !usedTextures.Contains(x.Name.ToString()));
        var fallback = Field<SoftObjectPropertyData>(textures.Single(x => x.Name.ToString() == fallbackTexture), "2Dtexture");
        var placeholder = fallback.Value;
        placeholder.AssetPath.AssetName = new FName(thumbnails,
            "/Game/T_Rex/Blueprints/UI/Textures/UI_Image/Title/JINKI3_logo_PC.JINKI3_logo_PC");
        fallback.Value = placeholder;
        WriteAsset(thumbnails, Path.Combine(output, PatchContent + "DT_Texture.uasset"));
    }

    private static T Field<T>(StructPropertyData row, string field) where T : PropertyData =>
        row.Value.OfType<T>().Single(x => x.Name.ToString().StartsWith(field + "_", StringComparison.Ordinal));
}
