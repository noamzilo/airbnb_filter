# Recon: what request does Airbnb's own search box make while you type a place,
# and does the response carry coordinates? Types an address into the search
# field on a live search page, then prints the autocomplete request URLs the
# page fired and the parsed shape of one response, fetched from page context
# (same cookies, same origin). Text-only output.
#
#   python scripts/recon_autocomplete.py [--headed]

import sys, json, time
sys.stdout.reconfigure(encoding="utf-8")
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

URL = ("https://www.airbnb.com/s/Asuncion--Paraguay/homes"
       "?adults=1&ne_lat=-25.26&ne_lng=-57.55&sw_lat=-25.32&sw_lng=-57.60"
       "&zoom=15&search_by_map=true")
QUERY = "Mariscal Lopez 3374, Asuncion"

opts = Options()
if "--headed" not in sys.argv:
    opts.add_argument("--headless")
opts.set_preference("intl.accept_languages", "en-US")
d = webdriver.Firefox(options=opts)
try:
    d.set_window_size(1400, 900)
    d.get(URL)
    time.sleep(5)

    # The compact bar expands into the structured search on click.
    for sel in ['[data-testid="little-search"]',
                '[data-testid="structured-search-input-field-query"]',
                'button[aria-label*="earch"]']:
        els = d.find_elements(By.CSS_SELECTOR, sel)
        if els:
            els[0].click(); time.sleep(1.5)
            break

    box = None
    for sel in ['input[data-testid="structured-search-input-field-query"]',
                'input[id*="bigsearch-query"]', 'input[placeholder*="earch"]']:
        els = d.find_elements(By.CSS_SELECTOR, sel)
        if els:
            box = els[0]; break
    print("search input found:", bool(box), box.get_attribute("data-testid") if box else "")
    if box:
        box.clear()
        for ch in QUERY:
            box.send_keys(ch); time.sleep(0.05)
        time.sleep(2.5)

    urls = d.execute_script("""
      return performance.getEntriesByType('resource').map(e=>e.name)
        .filter(n=>/autocomplete|satori|geocod|places/i.test(n));
    """)
    print("\ncandidate requests (%d):" % len(urls))
    for u in urls[-6:]:
        print(" ", u[:400])

    if urls:
        res = d.execute_script("""
          const url = arguments[0];
          return fetch(url, {credentials:'include'}).then(r=>r.text()).then(t=>t.slice(0,6000));
        """, urls[-1])
        print("\nresponse head:\n", res[:6000])
finally:
    d.quit()
