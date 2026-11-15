const codes = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

export type ColorName = keyof typeof codes;

export interface Colors {
  enabled: boolean;
  c: (name: ColorName, s: string) => string;
}

export function makeColors(enabled: boolean): Colors {
  return {
    enabled,
    c: (name, s) => (enabled ? `\x1b[${codes[name]}m${s}\x1b[0m` : s),
  };
}

export function shouldUseColor(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}
