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
    private static void PatchGalleryTabs(UAsset asset)
    {
        var menuClass = Get<ClassExport>(asset, "W_Recollection_Main_C");
        var defaults = Get<NormalExport>(asset, "Default__W_Recollection_Main_C");
        var labels = ((ArrayPropertyData)Property(defaults, "TextList")).Value.Cast<TextPropertyData>().ToArray();
        string[] names = { "CG", "Scene", "Defeat" };
        string[] widgets = { "W_Config_Button_Widget_CG", "W_Config_Button_Widget_Replay", "W_Config_Button_Widget_Music" };
        for (var i = 0; i < names.Length; i++)
        {
            SetLabel(labels[i], names[i]);
            SetLabel((TextPropertyData)Property(Get<NormalExport>(asset, widgets[i]), "Button_Text"), names[i]);
        }

        // The shipped game-specific list initializes each card through Set_WidgetInfo.
        var cgPackage = ImportIndex(asset, "/VN_Plugin/VN_Plus/BluePrint/Widget/Recollection/W_Gallery_List");
        cgPackage.ToImport(asset).ObjectName = new FName(asset, "/Game/JinkiGallery/W_Gallery_List");
        RedirectGalleryImport(asset, "Config/W_Config_Button_Widget", "W_Config_Button_Widget");
        RedirectGalleryImport(asset, "Recollection/W_OptionMain_Object", "W_OptionMain_Object");

        var scene = Get<NormalExport>(asset, "W_Recollection_List");
        var sceneSlot = ObjectTarget(asset, scene, "Slot");
        var overlay = (NormalExport)sceneSlot.OuterIndex.ToExport(asset);
        var added = new Dictionary<int, FPackageIndex>();
        var defeat = CloneExport(asset, scene, "W_Defeat_List", added);
        var defeatSlot = CloneExport(asset, sceneSlot, "Defeat_OverlaySlot", added);
        var defeatClass = AddImport(asset, "/Script/UMG", "WidgetBlueprintGeneratedClass",
            "/Game/JinkiGallery/W_Recollection_List", "W_Recollection_List_C");
        var defeatDefaults = AddImport(asset, "/Game/JinkiGallery/W_Recollection_List", "W_Recollection_List_C",
            "/Game/JinkiGallery/W_Recollection_List", "Default__W_Recollection_List_C");
        var defeatReferences = new Dictionary<int, FPackageIndex>(added)
        {
            [scene.ClassIndex.Index] = defeatClass,
            [ImportIndex(asset, "Default__W_Recollection_List_C").Index] = defeatDefaults,
        };
        defeat.ClassIndex = defeatClass;
        RemapExport(asset, defeatSlot, added);
        RemapExport(asset, defeat, defeatReferences);
        AppendSlot(asset, overlay, defeatSlot);
        foreach (var slot in new[] { sceneSlot, defeatSlot, ObjectTarget(asset, Get<NormalExport>(asset, "W_Gallery_List"), "Slot") })
        {
            SetByteProperty(slot, "HorizontalAlignment", 0);
            SetByteProperty(slot, "VerticalAlignment", 0);
        }
        var defeatField = (FObjectProperty)CloneField(menuClass, scene.ObjectName, defeat.ObjectName);
        defeatField.PropertyClass = defeatClass;
        menuClass.LoadedProperties = menuClass.LoadedProperties.Append(defeatField).ToArray();
        menuClass.SerializationBeforeSerializationDependencies.Add(defeatClass);
        var graph = Get<FunctionExport>(asset, "ExecuteUbergraph_W_Recollection_Main");
        var lists = (EX_SetArray)At(asset, graph, 0xB7);
        ReplaceWithJump(asset, graph, 0xB7, new EX_SetArray
        {
            AssigningProperty = lists.AssigningProperty,
            Elements = lists.Elements.Append(FieldVariable(defeat.ObjectName, IndexOf(asset, menuClass))).ToArray(),
        });

        var foreground = ThemeColor(0xE6F2FA);
        var title = Get<NormalExport>(asset, "ConfigTitle");
        SetLabel((TextPropertyData)Property(title, "Text"), "Gallery");
        SetFontSize(title, 50);
        SetColor(title, "ColorAndOpacity", foreground);
        SetLayout(ObjectTarget(asset, title, "Slot"), 160, 57, 0, 0);
        var cgTitle = Get<NormalExport>(asset, "CgTitle_Text");
        SetColor(cgTitle, "ColorAndOpacity", ThemeColor(0xB4C9D9));
        SetLayout(ObjectTarget(asset, cgTitle, "Slot"), 180, 972, 1250, 44);
        SetLabel((TextPropertyData)Property(Get<NormalExport>(asset, "TextBlock_161"), "Text"), "Back");
        SetFontSize(Get<NormalExport>(asset, "TextBlock_161"), 26);
        SetColor(Get<NormalExport>(asset, "Border_215"), "BrushColor", ThemeColor(0x28435C));

        var background = Get<NormalExport>(asset, "Widget_BackGround");
        var panel = Get<NormalExport>(asset, "Slot_BackGround");
        panel.Data.Add(CloneProperty(Property(background, "Brush")));
        SetColor(background, "Brush", ThemeColor(0x101C2B));
        SetColor(panel, "Brush", ThemeColor(0x18293B));
        SetColor(Get<NormalExport>(asset, "Slot_Border_BackGround"), "Brush", ThemeColor(0x35506B));
        SetColor(Get<NormalExport>(asset, "Slot_InBorder"), "BrushColor", ThemeColor(0x35506B));
        SetColor(Get<NormalExport>(asset, "Slot_OutBorder"), "BrushColor", ThemeColor(0x35506B));

        var tabs = Get<NormalExport>(asset, "Tab_Box");
        var tabsSlot = ObjectTarget(asset, tabs, "Slot");
        SetAnchors(tabsSlot, new FVector2D(1, 0), new FVector2D(1, 0));
        SetLayout(tabsSlot, -28, -42, 510, 54);
        ((BoolPropertyData)Property(tabsSlot, "bAutoSize")).Value = false;
        foreach (var entry in ((ArrayPropertyData)Property(tabs, "Slots")).Value.Cast<ObjectPropertyData>())
            FindProperty<FloatPropertyData>(Property((NormalExport)entry.Value.ToExport(asset), "Padding"), "Right").Value = 10;
    }

    private static void BuildGalleryWidgets(string extracted, string output)
    {
        const string gameCg = GameContent + "T_Rex/Blueprints/UI/Recollection/WBP_Recollection_Parts/W_Gallery_List.uasset";
        var cg = LoadAsset(Path.Combine(extracted, gameCg));
        var scroll = Get<NormalExport>(cg, "ScrollBox_32");
        SetLayout(ObjectTarget(cg, scroll, "Slot"), -772, -337, 1544, 674);
        WriteAsset(cg, Path.Combine(output, PatchContent + "W_Gallery_List.uasset"));

        var defeatList = LoadAsset(Path.Combine(extracted, GalleryWidgetPath + "W_Recollection_List.uasset"));
        PatchSceneGrid(defeatList, true);
        RedirectGalleryImport(defeatList, "Recollection/W_Recollection_Button", "W_Recollection_Button");
        WriteAsset(defeatList, Path.Combine(output, PatchContent + "W_Recollection_List.uasset"));
        var defeatCard = LoadAsset(Path.Combine(extracted, GalleryWidgetPath + "W_Recollection_Button.uasset"));
        PatchSceneCards(defeatCard, true);
        WriteAsset(defeatCard, Path.Combine(output, PatchContent + "W_Recollection_Button.uasset"));

        // Copy the plug-in tab widget under the gallery mount for independent styling.
        var tabPackage = Directory.GetFiles(Path.Combine(extracted, WidgetPath), "W_Config_Button_Widget.uasset", SearchOption.AllDirectories).Single();
        var tab = LoadAsset(tabPackage);
        var text = Get<NormalExport>(tab, "TextBlock_3");
        SetFontSize(text, 23);
        SetColor(text, "ColorAndOpacity", ThemeColor(0xE6F2FA));
        ((BytePropertyData)Property(text, "Justification")).Value = 1;
        SetLayout(ObjectTarget(tab, Get<NormalExport>(tab, "Button_632"), "Slot"), 0, 0, 160, 54);
        var parent = ImportIndex(tab, "/VN_Plugin/VN_Plus/BluePrint/Widget/Config/W_ConfigButton_Object");
        parent.ToImport(tab).ObjectName = new FName(tab, "/Game/JinkiGallery/W_ConfigButton_Object");
        WriteAsset(tab, Path.Combine(output, PatchContent + "W_Config_Button_Widget.uasset"));

        var options = LoadAsset(Path.Combine(extracted, GalleryWidgetPath + "W_OptionMain_Object.uasset"));
        RedirectGalleryImport(options, "Config/W_ConfigButton_Object", "W_ConfigButton_Object");
        WriteAsset(options, Path.Combine(output, PatchContent + "W_OptionMain_Object.uasset"));

        var stylePackage = Directory.GetFiles(Path.Combine(extracted, WidgetPath), "W_ConfigButton_Object.uasset", SearchOption.AllDirectories).Single();
        var style = LoadAsset(stylePackage);
        var visible = Get<FunctionExport>(style, "ButtonVisible");
        SetTabTint(0x78, ThemeColor(0x286478));
        SetTabTint(0x106, ThemeColor(0x22384D));
        WriteAsset(style, Path.Combine(output, PatchContent + "W_ConfigButton_Object.uasset"));

        void SetTabTint(uint offset, FLinearColor color)
        {
            var context = (EX_Context)At(style, visible, offset);
            var call = (EX_FinalFunction)context.ContextExpression;
            var value = (EX_StructConst)call.Parameters[0];
            value.Value = new KismetExpression[]
            {
                new EX_FloatConst { Value = color.R }, new EX_FloatConst { Value = color.G },
                new EX_FloatConst { Value = color.B }, new EX_FloatConst { Value = color.A },
            };
        }
    }

    private static void RedirectGalleryImport(UAsset asset, string source, string target)
    {
        var index = ImportIndex(asset, "/VN_Plugin/VN_Plus/BluePrint/Widget/" + source);
        index.ToImport(asset).ObjectName = new FName(asset, "/Game/JinkiGallery/" + target);
    }

    private static void UnlockCgGallery(UAsset asset)
    {
        var open = Get<FunctionExport>(asset, "OpenWidgetFunction");
        foreach (var offset in new uint[] { 0x603, 0x623, 0x643, 0x663 })
            ((EX_FloatConst)((EX_Let)At(asset, open, offset)).Expression).Value = 8;

        var gallery = Get<FunctionExport>(asset, "Make_DifferenceMap");
        const uint lookupOffset = 0x289;
        const uint gateOffset = 0x2BF;
        const uint addTextureOffset = 0x2C9;
        var lookup = At(asset, gallery, lookupOffset);
        var gate = At(asset, gallery, gateOffset);
        if (lookup is not EX_Context { ContextExpression: EX_LocalVirtualFunction findFlag } ||
            findFlag.VirtualFunctionName.ToString() != "Find_TextureFlag" || gate is not EX_PopExecutionFlowIfNot)
        {
            throw new InvalidDataException("The original CG unlock gate could not be located");
        }

        var script = gallery.ScriptBytecode.ToList();
        var index = script.IndexOf(lookup);
        var end = script.IndexOf(At(asset, gallery, addTextureOffset));
        var jump = new EX_Jump { CodeOffset = addTextureOffset };
        var padding = checked((int)(addTextureOffset - lookupOffset - jump.GetSize(asset)));
        script.RemoveRange(index, end - index);
        script.Insert(index, jump);
        script.InsertRange(index + 1, Enumerable.Range(0, padding).Select(_ => new EX_Nothing()));
        gallery.ScriptBytecode = script.ToArray();
    }

    private static void RaiseCgPreview(UAsset asset)
    {
        var click = Get<FunctionExport>(asset, "Click");
        if (At(asset, click, 0x9D) is not EX_Context { ContextExpression: EX_FinalFunction add } ||
            add.StackNode.ToImport(asset).ObjectName.ToString() != "AddToViewport" ||
            add.Parameters is not [EX_IntConst layer])
            throw new InvalidDataException("The original CG preview viewport call could not be located");

        layer.Value = GalleryLayer + 1;
    }

    private static void PatchSceneGrid(UAsset asset, bool withThumbnails)
    {
        var tiles = Get<NormalExport>(asset, "Slot_TileView");
        SetLayout(ObjectTarget(asset, tiles, "Slot"), 0, 0, 1496, 674);
        ((FloatPropertyData)Property(tiles, "EntryHeight")).Value = withThumbnails ? 128 : 88;
        ((FloatPropertyData)Property(tiles, "EntryWidth")).Value = 620;
    }

    private static void PatchSceneCards(UAsset asset, bool withThumbnails)
    {
        var widget = Get<ClassExport>(asset, "W_Recollection_Button_C");
        var image = Get<NormalExport>(asset, "List_Texutre");
        var click = Get<NormalExport>(asset, "Button_100");
        var slot = (NormalExport)((ObjectPropertyData)Property(click, "Slot")).Value.ToExport(asset);
        var panel = (NormalExport)slot.OuterIndex.ToExport(asset);
        var card = Get<NormalExport>(asset, "BackGround_Boder");
        FillCanvas(ObjectTarget(asset, Get<NormalExport>(asset, "InvalidationBox_84"), "Slot"), 0, 0, 0, 0);
        FillCanvas(ObjectTarget(asset, card, "Slot"), 6, 5, 10, 5);
        FillCanvas(slot, 6, 5, 10, 5);
        SetColor(card, "BrushColor", ThemeColor(0x35506B));
        SetColor(Get<NormalExport>(asset, "BackGround"), "ColorAndOpacity", ThemeColor(0x21374C));
        var added = new Dictionary<int, FPackageIndex>();
        var label = CloneExport(asset, image, "SceneLabel", added);
        var labelSlot = CloneExport(asset, slot, "SceneLabel_Slot", added);

        var textClass = AddImport(asset, "/Script/CoreUObject", "Class", "/Script/UMG", "TextBlock");
        var textTemplate = AddImport(asset, "/Script/UMG", "TextBlock", "/Script/UMG", "Default__TextBlock");
        var oldClass = label.ClassIndex;
        var oldTemplate = label.TemplateIndex;
        label.ClassIndex = textClass;
        label.TemplateIndex = textTemplate;
        var remap = new Dictionary<int, FPackageIndex>(added)
        {
            [IndexOf(asset, click).Index] = IndexOf(asset, label),
            [oldClass.Index] = textClass,
        };
        if (oldTemplate.Index != 0) remap.Add(oldTemplate.Index, textTemplate);
        RemapExport(asset, labelSlot, remap);
        RemapExport(asset, label, remap);
        ((ObjectPropertyData)Property(label, "Slot")).Value = IndexOf(asset, labelSlot);
        ((IntPropertyData)Property(labelSlot, "ZOrder")).Value = 2;
        label.Data.Add(new EnumPropertyData(new FName(asset, "Visibility"))
        {
            EnumType = new FName(asset, "ESlateVisibility"),
            Value = new FName(asset, "ESlateVisibility::HitTestInvisible"),
        });
        image.Data.Add(new EnumPropertyData(new FName(asset, "Visibility"))
        {
            EnumType = new FName(asset, "ESlateVisibility"),
            Value = new FName(asset, withThumbnails ? "ESlateVisibility::HitTestInvisible" : "ESlateVisibility::Hidden"),
        });
        FillCanvas(labelSlot, withThumbnails ? 224 : 24, withThumbnails ? 31 : 17, 30, 16);
        if (withThumbnails)
        {
            var imageSlot = ObjectTarget(asset, image, "Slot");
            var origin = new FVector2D(0, 0);
            SetAnchors(imageSlot, origin, origin);
            FindProperty<Vector2DPropertyData>(Property(imageSlot, "LayoutData"), "Alignment").Value = origin;
            SetLayout(imageSlot, 16, 10, 192, 108);
        }
        asset.AddNameReference(new FString("ByteProperty"));
        label.Data.Add(new BytePropertyData(new FName(asset, "Justification")) { EnumType = new FName(asset, "None"), Value = 0 });
        label.Data.Add(new BoolPropertyData(new FName(asset, "AutoWrapText")) { Value = true });
        label.Data.Add(new StructPropertyData(new FName(asset, "Font"))
        {
            StructType = new FName(asset, "SlateFontInfo"),
            Value = new List<PropertyData> { new IntPropertyData(new FName(asset, "Size")) { Value = 21 } },
        });
        AppendSlot(asset, panel, labelSlot);

        var field = (FObjectProperty)CloneField(widget, image.ObjectName, label.ObjectName);
        field.PropertyClass = textClass;
        widget.LoadedProperties = widget.LoadedProperties.Append(field).ToArray();
        widget.SerializationBeforeSerializationDependencies.Add(IndexOf(asset, label));

        var caption = SceneCaption(asset);
        var text = new EX_VirtualFunction { VirtualFunctionName = new FName(asset, "SetText"), Parameters = new[] { caption } };
        var original = Get<FunctionExport>(asset, "ExecuteUbergraph_W_Recollection_Button");
        var addItem = At(asset, original, 0x1D);
        ReplaceWithJump(asset, original, 0x1D, addItem, new EX_Context
        {
            ObjectExpression = FieldVariable(label.ObjectName, IndexOf(asset, widget)),
            ContextExpression = text,
            RValuePointer = new KismetPropertyPointer { New = new FFieldPath { Path = Array.Empty<FName>(), ResolvedOwner = new FPackageIndex(0) } },
            Offset = text.GetSize(asset),
        });
    }

    private static KismetExpression SceneCaption(UAsset asset)
    {
        var targetField = FieldVariable(new FName(asset, "Target_Label"), ImportIndex(asset, "Recollection_Object_C"));
        var title = new EX_Context
        {
            ObjectExpression = FieldVariable(new FName(asset, "Recollection Object"), ImportIndex(asset, "W_Recollection_ButtonObject_C")),
            ContextExpression = targetField,
            RValuePointer = targetField.Variable,
            Offset = targetField.GetSize(asset),
        };
        var textLibrary = ImportIndex(asset, "KismetTextLibrary", required: false);
        if (textLibrary.Index == 0)
            textLibrary = AddImport(asset, "/Script/CoreUObject", "Class", "/Script/Engine", "KismetTextLibrary");
        var stringToText = AddFunctionImport(asset, textLibrary, "Conv_StringToText");
        return new EX_CallMath { StackNode = stringToText, Parameters = new[] { title } };
    }

    private static void AppendSlot(UAsset asset, NormalExport panel, NormalExport slot)
    {
        var slots = (ArrayPropertyData)Property(panel, "Slots");
        var entry = (ObjectPropertyData)CloneProperty(slots.Value[0]);
        entry.Value = IndexOf(asset, slot);
        slots.Value = slots.Value.Append(entry).ToArray();
    }

    private static void SetLabel(TextPropertyData property, string value)
    {
        property.HistoryType = TextHistoryType.None;
        property.CultureInvariantString = new FString(value);
    }

    private static FLinearColor ThemeColor(int rgb)
    {
        static float Linear(int value) => MathF.Pow((value / 255f + 0.055f) / 1.055f, 2.4f);
        return new FLinearColor(Linear((rgb >> 16) & 255), Linear((rgb >> 8) & 255), Linear(rgb & 255), 1f);
    }

    private static void SetColor(NormalExport widget, string property, FLinearColor color) =>
        Properties(Property(widget, property)).OfType<LinearColorPropertyData>().Single().Value = color;

    private static void SetFontSize(NormalExport widget, int size) => FindProperty<IntPropertyData>(Property(widget, "Font"), "Size").Value = size;

    private static void SetByteProperty(NormalExport widget, string name, byte value)
    {
        var property = widget.Data.OfType<BytePropertyData>().SingleOrDefault(x => x.Name.ToString() == name);
        if (property == null)
        {
            widget.Asset.AddNameReference(new FString("ByteProperty"));
            property = new BytePropertyData(new FName(widget.Asset, name)) { EnumType = new FName(widget.Asset, "None") };
            widget.Data.Add(property);
        }
        property.Value = value;
    }

    private static void SetLayout(NormalExport slot, float left, float top, float right, float bottom)
    {
        var offsets = FindProperty<StructPropertyData>(Property(slot, "LayoutData"), "Offsets");
        foreach (var (name, value) in new[] { ("Left", left), ("Top", top), ("Right", right), ("Bottom", bottom) })
        {
            var property = offsets.Value.OfType<FloatPropertyData>().SingleOrDefault(x => x.Name.ToString() == name);
            if (property == null)
            {
                property = new FloatPropertyData(new FName(slot.Asset, name));
                offsets.Value.Add(property);
            }
            property.Value = value;
        }
    }

    private static void SetAnchors(NormalExport slot, FVector2D min, FVector2D max)
    {
        var layout = Property(slot, "LayoutData");
        FindProperty<Vector2DPropertyData>(layout, "Minimum").Value = min;
        FindProperty<Vector2DPropertyData>(layout, "Maximum").Value = max;
    }

    private static void FillCanvas(NormalExport slot, float left, float top, float right, float bottom)
    {
        SetAnchors(slot, new FVector2D(0, 0), new FVector2D(1, 1));
        var alignment = Properties(Property(slot, "LayoutData")).OfType<Vector2DPropertyData>().SingleOrDefault(x => x.Name.ToString() == "Alignment");
        if (alignment != null) alignment.Value = new FVector2D(0, 0);
        SetLayout(slot, left, top, right, bottom);
    }
}
