import logging
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path


class Logger:
    """Thin wrapper over the stdlib logger writing to a rotating daily file.

    In addition to `info`/`warning`/`error`/`debug`, any attribute of the form
    `module_action(...)` is accepted and formatted as `[MODULE] action - fields`,
    so call sites can log structured events without predefining every method.
    """

    def __init__(self, log_dir: str, console_output: bool = False):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger("pawchive")
        self.logger.setLevel(logging.INFO)
        self.logger.handlers.clear()
        self.logger.propagate = False

        formatter = logging.Formatter(
            '%(asctime)s [%(levelname)s] %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S',
        )

        handler = RotatingFileHandler(
            self.log_dir / datetime.now().strftime("%Y-%m-%d.log"),
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding='utf-8',
        )
        handler.setFormatter(formatter)
        self.logger.addHandler(handler)

        if console_output:
            console = logging.StreamHandler()
            console.setFormatter(formatter)
            self.logger.addHandler(console)

    def info(self, msg: str):
        self.logger.info(msg)

    def warning(self, msg: str):
        self.logger.warning(msg)

    def error(self, msg: str):
        self.logger.error(msg)

    def debug(self, msg: str):
        self.logger.debug(msg)

    @staticmethod
    def _normalize(value) -> str:
        text = str(value).replace('\n', ' ').replace('\r', ' ')
        while '  ' in text:
            text = text.replace('  ', ' ')
        return text.strip()

    def __getattr__(self, attr: str):
        if attr.startswith('_') or '_' not in attr:
            raise AttributeError(attr)

        module, action = attr.split('_', 1)

        def _event(*args, **kwargs):
            level = kwargs.pop('level', 'info')
            parts = [self._normalize(a) for a in args]
            if kwargs:
                parts.append(', '.join(f"{k}={self._normalize(v)}" for k, v in kwargs.items()))
            message = ' | '.join(p for p in parts if p)
            line = f"[{module.upper()}] {action}"
            if message:
                line += f" - {message}"
            getattr(self.logger, level if level in ('info', 'warning', 'error', 'debug') else 'info')(line)

        return _event
