from dataclasses import dataclass, field


@dataclass
class ConversionReport:
    chapters: int = 0
    kept_ja: int = 0
    dropped_zh: int = 0
    kept_blank: int = 0
    kept_original: int = 0
    deduped_headings: int = 0
    restored_css: int = 0
    vertical: bool = False
    warnings: list[str] = field(default_factory=list)
    # Chinese editions
    kept_zh: int = 0
    untranslated: int = 0
    """Japanese lines with no translation, kept as they are."""

    def describe(self) -> str:
        if self.kept_zh:
            text = (
                f"{self.chapters} chapter(s): kept {self.kept_zh} translated paragraph(s), "
                f"dropped their Japanese lines"
            )
            if self.untranslated:
                text += f", kept {self.untranslated} untranslated Japanese line(s)"
            return text
        text = (
            f"{self.chapters} chapter(s): kept {self.kept_ja} Japanese "
            f"paragraph(s) + {self.kept_blank} blank line(s), "
            f"dropped {self.dropped_zh} Chinese paragraph(s)"
        )
        if self.kept_original:
            text += f", left {self.kept_original} original-markup paragraph(s) alone"
        if self.deduped_headings:
            text += f", merged {self.deduped_headings} duplicated heading(s)"
        if self.vertical:
            text += (
                "; vertical-rl restored from the publisher's own stylesheet"
                if self.restored_css
                else "; vertical-rl applied"
            )
        return text
