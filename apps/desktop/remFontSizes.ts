import type { Plugin } from "postcss";

/**
 * Font sizes in rem instead of px (`text-[13px]` becomes 0.8125rem), so every text in the app
 * follows the root font size. On desktop that is 16px and nothing changes; on iPhone and iPad
 * main.tsx sets it from the user's text size (Settings › Display & Brightness › Text Size).
 * Only plain lengths are converted: a size written as an expression, such as the
 * `max(16px, 1em)` that keeps iOS from zooming into fields, stays as written.
 */
export function remFontSizes(): Plugin {
  return {
    postcssPlugin: "rem-font-sizes",
    Declaration: {
      "font-size": (decl) => {
        const px = /^(\d*\.?\d+)px$/.exec(decl.value.trim());
        if (px) decl.value = `${Number((Number(px[1]) / 16).toFixed(4))}rem`;
      },
    },
  };
}
remFontSizes.postcss = true;
