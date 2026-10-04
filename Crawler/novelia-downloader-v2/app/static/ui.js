"use strict";

const UI = (() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new WeakMap();
  const closings = new WeakMap();
  const loaders = new WeakMap();

  function animate(element, frames, duration = 180) {
    if (!element || reduced.matches) return Promise.resolve();
    animations.get(element)?.cancel();
    const animation = element.animate(frames, {
      duration, easing: "cubic-bezier(.2,.7,.2,1)",
    });
    animations.set(element, animation);
    return animation.finished.catch(() => {}).finally(() => {
      if (animations.get(element) === animation) animations.delete(element);
    });
  }

  function reveal(element) {
    return animate(element, [{ opacity: 0 }, { opacity: 1 }], 150);
  }

  function show(element, visible) {
    if (element.hidden === !visible) return;
    element.hidden = !visible;
    if (visible) reveal(element);
  }

  function openDialog(dialog) {
    if (dialog.open || closings.has(dialog)) return;
    dialog.showModal();
    const sheet = dialog.classList.contains("sheet");
    animate(dialog, [
      { opacity: 0, transform: sheet ? "translateX(24px)" : "translateY(8px) scale(.99)" },
      { opacity: 1, transform: "none" },
    ], sheet ? 220 : 180);
  }

  function closeDialog(dialog) {
    if (closings.has(dialog)) return closings.get(dialog);
    if (!dialog.open) return Promise.resolve();
    const sheet = dialog.classList.contains("sheet");
    const closing = animate(dialog, [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: sheet ? "translateX(16px)" : "translateY(4px) scale(.99)" },
    ], 130).then(() => dialog.close()).finally(() => closings.delete(dialog));
    closings.set(dialog, closing);
    return closing;
  }

  function pending(button, active, label = "Working…") {
    if (active) {
      button.dataset.idleLabel = button.textContent;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = label;
    } else {
      button.textContent = button.dataset.idleLabel || button.textContent;
      delete button.dataset.idleLabel;
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }

  function loading(element) {
    const marker = {};
    loaders.set(element, marker);
    const timer = setTimeout(() => {
      if (loaders.get(element) === marker) element.setAttribute("aria-busy", "true");
    }, 180);
    return () => {
      clearTimeout(timer);
      if (loaders.get(element) === marker) {
        loaders.delete(element);
        element.removeAttribute("aria-busy");
      }
    };
  }

  function reorder(element, mutate) {
    const positions = new Map([...element.children].map(child => [child, child.getBoundingClientRect().top]));
    mutate();
    positions.forEach((top, child) => {
      const offset = top - child.getBoundingClientRect().top;
      if (offset) animate(child, [{ transform: `translateY(${offset}px)` }, { transform: "none" }], 200);
    });
  }

  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      if (!dialog.querySelector('[aria-busy="true"]')) closeDialog(dialog);
    });
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
        if (!dialog.querySelector('[aria-busy="true"]')) closeDialog(dialog);
      }
    });
  });

  document.querySelectorAll('[role="radiogroup"]').forEach(group => {
    const buttons = [...group.querySelectorAll('[role="radio"]')];
    buttons.forEach(button => { button.tabIndex = button.getAttribute("aria-checked") === "true" ? 0 : -1; });
    group.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    });
  });

  return { animate, reveal, show, openDialog, closeDialog, pending, loading, reorder };
})();
