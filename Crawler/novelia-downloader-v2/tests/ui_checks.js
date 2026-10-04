// Evaluate this async function in the preview browser (tests.ui_preview).
async () => {
  const checks = [];
  const assert = (value, label) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const status = await api("/api/status");
  if (!status.data_root.includes("novelia-ui-qa-")) throw new Error("Run only against isolated UI fixtures.");
  for (const dialog of $$('dialog[open]')) await UI.closeDialog(dialog);

  await switchView("settings");
  const setting = $('[name="auto_convert"]');
  const expected = !setting.checked;
  setting.click();
  assert($("#settings-form").dataset.dirty === "true", "settings track edits");
  await switchView("library");
  await switchView("settings");
  assert(setting.checked === expected, "unsaved settings survive navigation");
  const engine = $("#engine-list").firstElementChild;
  const engineName = engine.dataset.engineName;
  const nextEngine = engine.nextElementSibling.dataset.engineName;
  const move = $('[data-dir="1"]', engine);
  move.click();
  assert($(`[data-engine-name="${engineName}"]`) === engine, "engine reorder preserves DOM identity");
  assert(engine.previousElementSibling?.dataset.engineName === nextEngine, "engine priority changes in the correct order");
  $("#settings-form").requestSubmit();
  assert($("#save-settings").getAttribute("aria-busy") === "true", "save displays pending state");
  await delay(350);
  assert($("#settings-form").dataset.dirty === "false", "save clears the dirty state");
  assert((await api("/api/settings")).auto_convert === expected, "save persists settings");

  await switchView("library");
  const nativeFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (String(url).startsWith("/api/works?")) {
      const query = new URL(url, location.origin).searchParams.get("query");
      if (["slow", "fast"].includes(query)) {
        await delay(query === "slow" ? 350 : 40);
        return new Response(JSON.stringify({ items: [], total: query === "slow" ? 99 : 0, page: 1, page_size: 48 }), { headers: { "Content-Type": "application/json" } });
      }
    }
    return nativeFetch(url, options);
  };
  try {
    $("#library-query").value = "slow";
    const slow = loadLibrary(true);
    $("#library-query").value = "fast";
    await Promise.all([slow, loadLibrary(true)]);
    assert(state.library.total === 0, "older list responses cannot overwrite newer results");
    assert(!$("#library-list").hasAttribute("aria-busy"), "list loading state clears after overlapping requests");
  } finally {
    window.fetch = nativeFetch;
    $("#library-query").value = "";
    await loadLibrary(true);
  }

  const radio = $('[data-state=""]');
  radio.focus();
  radio.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert(document.activeElement.dataset.state === "saved", "filters support keyboard navigation");
  await delay(200);
  await openWork("wenku/000000000000000000000001");
  assert($("#work-dialog").getBoundingClientRect().width <= innerWidth && $("#work-dialog").scrollWidth <= $("#work-dialog").clientWidth, "details fit the viewport without horizontal overflow");
  toast("Preview feedback", true);
  assert($("#toast").matches(":popover-open"), "feedback uses the top layer above modal dialogs");
  const notice = $("#toast").getBoundingClientRect();
  const close = $('[data-close="work-dialog"]').getBoundingClientRect();
  assert(notice.top >= close.bottom || notice.bottom <= close.top || notice.right <= close.left || notice.left >= close.right, "feedback leaves the dialog close button visible");
  clearTimeout(toastTimer);
  $("#toast").hidePopover();
  $("#toast").hidden = true;
  const toggle = $("#intro-toggle");
  toggle.click();
  assert(toggle.getAttribute("aria-expanded") === "true", "introduction expands with an accessible state");
  await UI.closeDialog($("#work-dialog"));
  assert(!$("#work-dialog").open, "sheet closes after its exit animation");

  actions["open-crawl"]();
  await delay(220);
  const downloadDialog = $("#crawl-dialog");
  assert($(".dialog-foot", downloadDialog).getBoundingClientRect().bottom <= downloadDialog.getBoundingClientRect().bottom, "download actions remain inside the dialog on short screens");
  $('[name="kind"][value="manual"]').click();
  $('[name="keys"]').value = "wenku/000000000000000000000001";
  $("#crawl-form").requestSubmit();
  await delay(500);
  assert(!$("#crawl-dialog").open, "download form closes after queueing");
  assert(state.view === "tasks", "queueing navigates to tasks");
  const queued = state.jobs.find(job => job.status === "queued");
  assert(Boolean(queued), "download task is queued in the isolated server");
  await api(`/api/jobs/${queued.id}/cancel`, { method: "POST" });

  await switchView("catalog");
  const pick = $("[data-catalog-key]");
  pick.click();
  assert(!$("#selection-bar").hidden && $("#remove-selected").hidden, "catalog selection exposes only applicable actions");
  await actions["clear-selection"]();
  await switchView("library");
  $('[data-state=""]').click();
  await delay(200);
  const local = $("[data-key]");
  local.click();
  assert(!$("#selection-bar").hidden && !$("#remove-selected").hidden, "library selection exposes removal");
  actions["remove-selected"]();
  assert(!$("#delete-local-files").checked, "removal keeps files by default");
  assert($("#remove-dialog").scrollWidth <= $("#remove-dialog").clientWidth, "removal dialog has no horizontal overflow");
  await UI.closeDialog($("#remove-dialog"));
  await actions["clear-selection"]();
  return { passed: checks.length, checks };
}
