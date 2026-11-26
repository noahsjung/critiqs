/**
 * Copies `text`, returning whether it worked: the clipboard API, or where a
 * browser refuses it, a selected field and the copy command, which says
 * false when nothing was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    try {
      field.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}
