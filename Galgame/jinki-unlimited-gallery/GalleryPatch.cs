using UAssetAPI;

namespace JinkiUnlimited.Gallery;

internal static partial class GalleryPatch
{
    private const string GameContent = "JinkiUnlimited/Content/";
    private const string VnContent = "JinkiUnlimited/Plugins/VN_Plugin/Content/VN_Plus/";
    private const string WidgetPath = VnContent + "BluePrint/Widget/";
    private const string GalleryWidgetPath = WidgetPath + "Recollection/";
    private const string PatchContent = GameContent + "JinkiGallery/";
    private const string TitleAsset = GameContent + "T_Rex/Blueprints/UI/Title/WBP_Alpha2_TItle.uasset";
    private const int GalleryLayer = 20;

    internal static void Build(string extracted, string output)
    {
        PatchAsset(TitleAsset, PatchTitle);
        VerifyTitleMenu(LoadAsset(Path.Combine(output, TitleAsset)));
        PatchAsset(WidgetPath + "Title/W_TItleObject.uasset", PatchGalleryOpener);
        PatchAsset(GalleryWidgetPath + "W_Recollection_Main.uasset", PatchGalleryTabs);
        PatchAsset(GalleryWidgetPath + "W_Gallery_List_Object.uasset", UnlockCgGallery);
        PatchAsset(GalleryWidgetPath + "W_GalleryObject.uasset", RaiseCgPreview);
        PatchAsset(GalleryWidgetPath + "RecoolectionListObject.uasset", PatchSceneList);
        PatchAsset(GalleryWidgetPath + "W_Recollection_List.uasset", asset => PatchSceneGrid(asset, false));
        PatchAsset(GalleryWidgetPath + "W_Recollection_Button.uasset", asset => PatchSceneCards(asset, false));
        PatchAsset(VnContent + "BluePrint/VNInstanceObject.uasset", PatchSaveGuards);
        BuildGalleryWidgets(extracted, output);
        BuildSceneCatalog(extracted, output);

        void PatchAsset(string path, Action<UAsset> change)
        {
            var asset = LoadAsset(Path.Combine(extracted, path));
            change(asset);
            WriteAsset(asset, Path.Combine(output, path));
        }
    }
}
