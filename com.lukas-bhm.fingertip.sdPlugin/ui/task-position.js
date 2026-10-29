function bindTaskPosition(input, api) {
  let saved = 1;
  let editing = false;
  const valid = () => /^[0-9]{1,2}$/.test(input.value)
    && Number(input.value) >= 1 && Number(input.value) <= 99;
  const save = () => {
    if (!valid()) return;
    saved = Number(input.value);
    api.setSetting('taskPosition', saved);
  };
  api.onSettings(settings => {
    // Settings echoes can arrive between keystrokes. Never replace a draft.
    if (editing) return;
    saved = settings.taskPosition;
    input.value = String(saved);
  });
  input.addEventListener('focus', () => { editing = true; });
  input.addEventListener('input', save);
  input.addEventListener('blur', () => {
    save();
    editing = false;
    input.value = String(saved);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      input.value = String(Math.max(1, Math.min(99, (valid() ? Number(input.value) : saved)
        + (event.key === 'ArrowUp' ? 1 : -1))));
      save();
    }
  });
}
