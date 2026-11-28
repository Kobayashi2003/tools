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
    private static void PatchTitle(UAsset asset)
    {
        var title = Get<ClassExport>(asset, "WBP_Alpha2_TItle_C");
        var titleIndex = IndexOf(asset, title);
        var option = Get<NormalExport>(asset, "Option_Button");
        var optionBox = Get<NormalExport>(asset, "OptionBox");
        var exit = Get<NormalExport>(asset, "EXIT_Button");
        var verticalSlot = ObjectTarget(asset, optionBox, "Slot");
        var verticalBox = (NormalExport)verticalSlot.OuterIndex.ToExport(asset);
        var menuSlots = (ArrayPropertyData)Property(verticalBox, "Slots");
        var childSlot = ObjectTarget(asset, option, "Slot");
        var optionNavigation = ObjectTarget(asset, option, "Navigation");
        var exitNavigation = ObjectTarget(asset, exit, "Navigation");
        var optionClick = asset.Exports.OfType<FunctionExport>().Single(x => x.ObjectName.ToString().Contains("_Option_Button_"));
        var graph = Get<FunctionExport>(asset, "ExecuteUbergraph_WBP_Alpha2_TItle");

        var added = new Dictionary<int, FPackageIndex>();
        var gallery = CloneExport(asset, option, "Gallery_Button", added);
        var box = CloneExport(asset, optionBox, "GalleryBox", added);
        var slot = CloneExport(asset, verticalSlot, "Gallery_VerticalSlot", added);
        var inner = CloneExport(asset, childSlot, "Gallery_SizeSlot", added);
        var navigation = CloneExport(asset, optionNavigation, "Gallery_Navigation", added);
        var click = CloneExport(asset, optionClick, "OpenGallery_Clicked", added);

        foreach (var index in added.Values)
            RemapExport(asset, index.ToExport(asset), added);

        var galleryName = gallery.ObjectName;
        var boxName = box.ObjectName;
        ((StrPropertyData)Property(gallery, "ButtonText")).Value = new FString("Gallery");

        var menu = menuSlots.Value.Cast<ObjectPropertyData>().ToList();
        var optionRowIndex = IndexOf(asset, verticalSlot).Index;
        var optionRow = menu.Single(entry => entry.Value.Index == optionRowIndex);
        var galleryRow = (ObjectPropertyData)optionRow.Clone();
        galleryRow.Value = IndexOf(asset, slot);
        menu.Insert(menu.IndexOf(optionRow) + 1, galleryRow);
        menuSlots.Value = menu.ToArray();

        // Six 60-unit rows with 20-unit gaps fit the original 460-unit title rule.
        const float rowGap = 20;
        foreach (var entry in menu.Skip(1))
        {
            var row = (NormalExport)entry.Value.ToExport(asset);
            var padding = (StructPropertyData)Property(row, "Padding");
            padding.Value.OfType<FloatPropertyData>().Single(x => x.Name.ToString() == "Top").Value = rowGap;
        }
        var noExitLine = Get<NormalExport>(asset, "TitleLine_ExitNasi");
        var brush = (StructPropertyData)Property(noExitLine, "Brush");
        var imageSize = brush.Value.OfType<StructPropertyData>().Single(x => x.Name.ToString() == "ImageSize")
            .Value.OfType<Vector2DPropertyData>().Single();
        var rowHeight = ((FloatPropertyData)Property(optionBox, "HeightOverride")).Value;
        imageSize.Value = new FVector2D(imageSize.Value.X, (menu.Count - 1) * rowHeight + (menu.Count - 2) * rowGap);

        RenameNavigation(optionNavigation, "Down", galleryName);
        RenameNavigation(exitNavigation, "Up", galleryName);
        RenameNavigation(navigation, "Up", option.ObjectName);
        RenameNavigation(navigation, "Down", exit.ObjectName);

        title.LoadedProperties = title.LoadedProperties.Concat(new[]
        {
            CloneField(title, option.ObjectName, galleryName),
            CloneField(title, optionBox.ObjectName, boxName),
        }).ToArray();
        var clickIndex = IndexOf(asset, click);
        title.Children = title.Children.Append(clickIndex).ToArray();
        title.FuncMap.Add(click.ObjectName, clickIndex);
        title.CreateBeforeSerializationDependencies.Add(clickIndex);
        click.ScriptBytecode = new KismetExpression[]
        {
            new EX_LocalVirtualFunction { VirtualFunctionName = new FName(asset, "OpenRecollection"), Parameters = Array.Empty<KismetExpression>() },
            new EX_Return { ReturnExpression = new EX_Nothing() },
            new EX_EndOfScript(),
        };

        var binding = Get<NormalExport>(asset, "ComponentDelegateBinding_0");
        var bindings = (ArrayPropertyData)Property(binding, "ComponentDelegateBindings");
        var oldBinding = bindings.Value.Cast<StructPropertyData>().Single(x =>
            x.Value.OfType<NamePropertyData>().Any(x => x.Value == optionClick.ObjectName));
        var newBinding = (StructPropertyData)CloneProperty(oldBinding);
        newBinding.Value.OfType<NamePropertyData>().Single(x => x.Value == option.ObjectName).Value = galleryName;
        newBinding.Value.OfType<NamePropertyData>().Single(x => x.Value == optionClick.ObjectName).Value = click.ObjectName;
        bindings.Value = bindings.Value.Append(newBinding).ToArray();

        var show = (EX_Context)At(asset, graph, 0x180);
        var showGallery = new EX_Context
        {
            ObjectExpression = FieldVariable(boxName, titleIndex),
            Offset = show.Offset,
            PropertyType = show.PropertyType,
            RValuePointer = show.RValuePointer,
            ContextExpression = show.ContextExpression,
        };
        ReplaceWithJump(asset, graph, 0x180, show, showGallery);

        foreach (uint address in new uint[] { 0x447, 0x4EF, 0x5CD })
        {
            var list = (EX_SetArray)At(asset, graph, address);
            var entries = list.Elements.ToList();
            entries.Insert(entries.Count - 1, FieldVariable(galleryName, titleIndex));
            ReplaceWithJump(asset, graph, address, new EX_SetArray { AssigningProperty = list.AssigningProperty, Elements = entries.ToArray() });
        }

        // Title creation runs after a replay returns to the title map.
        var construct = At(asset, graph, 0x6ED);
        var subsystem = At(asset, graph, 0xCE2);
        var cast = (EX_Let)At(asset, graph, 0xD1D);
        var replay = FieldVariable(new FName(asset, "SceneGalleryFlag"), ImportIndex(asset, "VNInstanceObject_C"));
        var reset = new EX_LetBool
        {
            VariableExpression = new EX_Context
            {
                ObjectExpression = cast.Variable,
                ContextExpression = replay,
                RValuePointer = replay.Variable,
                Offset = replay.GetSize(asset),
            },
            AssignmentExpression = new EX_False(),
        };
        ReplaceWithJump(asset, graph, 0x6ED, subsystem, cast, reset, construct);

        var optionHover = (EX_AddMulticastDelegate)At(asset, graph, 0x86C);
        var delegateContext = (EX_Context)optionHover.Delegate;
        ReplaceWithJump(asset, graph, 0x86C, optionHover, new EX_AddMulticastDelegate
        {
            DelegateToAdd = optionHover.DelegateToAdd,
            Delegate = new EX_Context
            {
                ObjectExpression = FieldVariable(galleryName, titleIndex),
                Offset = delegateContext.Offset,
                PropertyType = delegateContext.PropertyType,
                RValuePointer = delegateContext.RValuePointer,
                ContextExpression = delegateContext.ContextExpression,
            },
        });
    }

    private static void VerifyTitleMenu(UAsset asset)
    {
        var verticalBox = Get<NormalExport>(asset, "VerticalBox_114");
        var rows = ((ArrayPropertyData)Property(verticalBox, "Slots")).Value.Cast<ObjectPropertyData>();
        var buttons = new List<string>();
        foreach (var entry in rows)
        {
            var row = (NormalExport)entry.Value.ToExport(asset);
            var box = ObjectTarget(asset, row, "Content");
            var slotIndex = ((ArrayPropertyData)Property(box, "Slots")).Value.Cast<ObjectPropertyData>().Single().Value;
            var slot = (NormalExport)slotIndex.ToExport(asset);
            var button = ObjectTarget(asset, slot, "Content");
            if (slot.OuterIndex.Index != IndexOf(asset, box).Index ||
                ((ObjectPropertyData)Property(slot, "Parent")).Value.Index != IndexOf(asset, box).Index ||
                ((ObjectPropertyData)Property(button, "Slot")).Value.Index != slotIndex.Index)
            {
                throw new InvalidDataException($"Invalid title row ownership for {box.ObjectName}");
            }
            buttons.Add(((StrPropertyData)Property(button, "ButtonText")).Value.Value);
        }

        if (!buttons.SequenceEqual(new[] { "New Game", "Continue", "Load", "Option", "Gallery", "EXIT" }))
            throw new InvalidDataException("The title menu must contain one independent row for each button");
    }

    private static void PatchGalleryOpener(UAsset asset)
    {
        var widget = AddImport(asset, "/Script/UMG", "WidgetBlueprintGeneratedClass",
            "/VN_Plugin/VN_Plus/BluePrint/Widget/Recollection/W_Recollection_Main", "W_Recollection_Main_C");
        var opener = Get<FunctionExport>(asset, "OpenRecollection");
        var creation = (EX_Context)((EX_LetObj)At(asset, opener, 0x2E)).AssignmentExpression;
        var add = (EX_Context)At(asset, opener, 0x6C);
        var call = (EX_FinalFunction)creation.ContextExpression;
        call.Parameters[1] = new EX_ObjectConst { Value = widget };
        creation.Offset = call.GetSize(asset);

        ((EX_IntConst)((EX_FinalFunction)add.ContextExpression).Parameters[0]).Value = GalleryLayer;
        opener.SerializationBeforeSerializationDependencies.Add(widget);
    }

    private static void RenameNavigation(NormalExport navigation, string direction, FName name)
    {
        var data = (StructPropertyData)Property(navigation, direction);
        var target = data.Value.OfType<NamePropertyData>().SingleOrDefault(x => x.Name.ToString() == "WidgetToFocus");
        if (target is null)
            throw new InvalidDataException($"No navigation destination for {navigation.ObjectName}.{direction}");
        target.Value = name;
    }
}
