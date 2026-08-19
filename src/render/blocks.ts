// Fallback renderer for terminals that don't support the Kitty graphics protocol: draws frames
// using the Unicode upper-half-block character (▀) with independent 24-bit foreground/background
// colors per cell, doubling the vertical resolution (each cell shows two source pixels stacked).
// No temp files, no graphics protocol, no tmux passthrough needed — it's all just ordinary text
// and SGR color codes, which every terminal (and tmux itself) already understands natively.
//
// Quality is deliberately not a goal here beyond "always works": no dithering, no per-cell
// diffing to avoid re-emitting unchanged SGR codes, nearest-neighbor sampling only. Takes the
// same `renderFramePng` shape as KittyRenderer so stream.ts's frame pipeline doesn't need to
// know which renderer it's driving.

import { decodePng } from './png.js';

const UPPER_HALF_BLOCK = '▀';

export interface BlocksRendererOptions {
  cols: number;
  rows: number;
}

export class BlocksRenderer {
  private cols: number;
  private rows: number;

  constructor(options: BlocksRendererOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to match KittyRenderer's interface
  async renderFramePng(png: Buffer): Promise<void> {
    const image = decodePng(png);
    const lines: string[] = [];

    for (let row = 0; row < this.rows; row++) {
      const topY = Math.min(image.height - 1, Math.floor((row / this.rows) * image.height));
      const botY = Math.min(image.height - 1, Math.floor(((row + 0.5) / this.rows) * image.height));
      let line = '';
      for (let col = 0; col < this.cols; col++) {
        const x = Math.min(image.width - 1, Math.floor((col / this.cols) * image.width));
        const topOffset = (topY * image.width + x) * 4;
        const botOffset = (botY * image.width + x) * 4;
        const fg = `${String(image.pixels[topOffset])};${String(image.pixels[topOffset + 1])};${String(image.pixels[topOffset + 2])}`;
        const bg = `${String(image.pixels[botOffset])};${String(image.pixels[botOffset + 1])};${String(image.pixels[botOffset + 2])}`;
        line += `\x1b[38;2;${fg}m\x1b[48;2;${bg}m${UPPER_HALF_BLOCK}`;
      }
      lines.push(line + '\x1b[0m');
    }

    process.stdout.write(lines.join('\r\n') + '\r\n');
  }

  dispose(): void {
    // Nothing to free — no temp files, no terminal-side image state.
  }
}
