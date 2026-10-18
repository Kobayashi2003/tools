import {
  createDefaultReaderInputMap,
  type ReaderShortcutGroup,
} from '../../core';

const DEFAULT_SHORTCUT_GROUPS =
  createDefaultReaderInputMap().description.shortcutGroups;

export function EpubKeyboardHelp({
  groups = DEFAULT_SHORTCUT_GROUPS,
}: {
  readonly groups?: readonly ReaderShortcutGroup[];
}) {
  return (
    <section
      className="epub-reader-panel epub-keyboard-help"
      aria-label="Keyboard shortcuts"
    >
      <p>Shortcuts work while focus is in the reading area.</p>
      {groups.map((group) => (
        <section key={group.label} className="epub-keyboard-help__group">
          <h3>{group.label}</h3>
          <dl>
            {group.items.map((item) => (
              <div key={item.action + item.keys.join()}>
                <dt>
                  {item.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{item.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </section>
  );
}
