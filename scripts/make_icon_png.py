# Rasterize extension/icon.svg to PNG at the sizes AMO's listing wants.
# Uses headless Firefox (already a project dependency via Selenium): draw the
# SVG onto a canvas, read it back as a data URL, write the bytes. No screenshots.
#
# Usage: python scripts/make_icon_png.py            # 128 (AMO listing) + 48/96
import base64, pathlib
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = (ROOT / "extension" / "icon.svg").read_text(encoding="utf-8")
SIZES = [48, 96, 128]

opts = Options()
opts.binary_location = FIREFOX
opts.add_argument("-headless")
driver = webdriver.Firefox(options=opts)
try:
    driver.get("about:blank")
    for size in SIZES:
        data_url = driver.execute_async_script(
            """
            const [svg, size, done] = arguments;
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = size; c.height = size;
                c.getContext('2d').drawImage(img, 0, 0, size, size);
                done(c.toDataURL('image/png'));
            };
            img.onerror = e => done('ERROR:' + e);
            img.src = 'data:image/svg+xml;base64,' + btoa(svg);
            """,
            SVG, size)
        if not data_url.startswith("data:image/png;base64,"):
            raise SystemExit(f"render failed at {size}px: {data_url[:200]}")
        out = ROOT / "extension" / f"icon-{size}.png"
        out.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
        print(f"wrote {out} ({out.stat().st_size} bytes)")
finally:
    driver.quit()
