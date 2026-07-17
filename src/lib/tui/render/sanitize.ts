/** Strip untrusted terminal control protocols while preserving printable Unicode. */
export function sanitizeTerminalText(input: string): string {
  return (
    input
      // OSC: ESC ] ... BEL or ST
      // eslint-disable-next-line no-control-regex -- strips an untrusted terminal protocol.
      .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      // DCS/SOS/PM/APC: ESC P/X/^/_ ... ST
      // eslint-disable-next-line no-control-regex -- strips an untrusted terminal protocol.
      .replaceAll(/\u001b[P_X^][\s\S]*?\u001b\\/g, "")
      // CSI including SGR/cursor/erase commands.
      // eslint-disable-next-line no-control-regex, regexp/no-obscure-range -- ECMA-48 CSI byte classes.
      .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // Remaining ESC and C0/C1 controls become spaces, except no hidden newline semantics.
      // eslint-disable-next-line no-control-regex -- intentional C0/C1 sanitization.
      .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  )
}
