const { chromium } = require("playwright");
const fs = require("fs");

const PIXEL_DIFF_SRC = require("fs")
  .readFileSync(`${__dirname}/../v54-stable.js`, "utf-8")
  .match(/const PIXEL_DIFF_SRC = `([\s\S]+?)`;/)[1];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // 2x2 fully-opaque white and fully-opaque black PNGs (the data URIs in the
  // original plan decoded to mostly-transparent garbage and produced ratio≈0.25).
  const whiteImg =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII=";
  const blackImg =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWNkYGD4zwAETAxQAAAOKAEDZn9myAAAAABJRU5ErkJggg==";
  await page.setContent("<html><body></body></html>");
  // NOTE: addScriptTag (not page.evaluate) is required so the `pixelDiff`
  // function declaration attaches to window and survives subsequent
  // page.evaluate calls. page.evaluate wraps source as an expression,
  // making any declared function local to that one call.
  await page.addScriptTag({ content: PIXEL_DIFF_SRC });
  const result = await page.evaluate(
    async ({ a, b }) => pixelDiff(a, b, { downsampleW: 2 }),
    { a: whiteImg, b: blackImg },
  );
  console.log("pixelDiff result:", result);
  if (result.ratio < 0.5) throw new Error("Expected high pixel diff");
  if (!("scale" in result) || !("mismatchedDimensions" in result)) {
    throw new Error(
      "pixelDiff result missing new scale/mismatchedDimensions fields",
    );
  }
  console.log("✅ pixelDiff smoke test passed");
  await browser.close();
})();
