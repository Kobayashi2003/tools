"""Optional path-formatting plugin, hot-reloaded on every use.

Each hook receives the formatter's inner function and returns a wrapper, so you
can massage inputs before the default logic runs. All three are no-ops; edit and
save, no restart. Delete this file to disable plugins.

    artist_folder(artist, template, group)   -> pathlib.Path
    post_folder(post, template, date_format) -> str
    format_file(name, idx, template)         -> str

`group` is the creator's path under `data/artists/`, feeding the `{group*}`
template variables ('' = download root).
"""


def format_artist_plugin(inner):
    def wrapper(artist, template, group=""):
        return inner(artist, template, group)
    return wrapper


def format_post_plugin(inner):
    def wrapper(post, template, date_format):
        return inner(post, template, date_format)
    return wrapper


def format_file_plugin(inner):
    def wrapper(name, idx, template):
        return inner(name, idx, template)
    return wrapper
