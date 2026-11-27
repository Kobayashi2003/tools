using JinkiUnlimited.Gallery;

if (args.Length != 2)
    throw new ArgumentException("Usage: GalleryPatch <extracted source tree> <patch asset tree>");

GalleryPatch.Build(args[0], args[1]);
