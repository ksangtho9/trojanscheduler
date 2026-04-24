import asyncio
import json
from playwright.async_api import async_playwright

TERM = "20263"

async def main():
    api_responses = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        async def on_response(response):
            url = response.url
            skip = ["datadoghq", ".js", ".css", ".svg", ".png", ".woff",
                    "simplesyllabus", "Terms/All", "Announcement",
                    "SimpleSyllabus", "Autocomplete", "Schools/",
                    "Programs/", "TermCode"]
            if any(x in url for x in skip):
                return
            try:
                ct = response.headers.get("content-type", "")
                if "json" in ct:
                    body = await response.json()
                    api_responses.append({"url": url, "body": body})
                    print(f"\n  NEW JSON  {url}")
                    print(f"    {json.dumps(body)[:600]}")
            except:
                pass

        page.on("response", on_response)

        # Go to CSCI program page
        await page.goto(
            f"https://classes.usc.edu/term/{TERM}/catalogue/school/ENGV/program/CSCI",
            wait_until="networkidle", timeout=30000,
        )
        await page.wait_for_timeout(2000)

        # Try direct course URL first
        print("Trying direct course URL...")
        await page.goto(
            f"https://classes.usc.edu/term/{TERM}/catalogue/school/ENGV/program/CSCI/course/270",
            wait_until="networkidle", timeout=15000,
        )
        await page.wait_for_timeout(2000)
        print(f"  URL after direct nav: {page.url}")

        # If that worked, done
        if api_responses:
            print("Direct URL triggered API calls!")
        else:
            # Go back to program page and inspect the DOM for 270
            print("\nBack to program page, inspecting DOM for CSCI 270 element...")
            await page.goto(
                f"https://classes.usc.edu/term/{TERM}/catalogue/school/ENGV/program/CSCI",
                wait_until="networkidle", timeout=30000,
            )
            await page.wait_for_timeout(2000)

            # Find all elements containing "270" and log their tag/class/role
            elements_info = await page.evaluate("""
                () => {
                    const results = [];
                    document.querySelectorAll('*').forEach(el => {
                        const text = el.textContent || '';
                        if (text.trim() === '270' || text.trim() === 'CSCI 270') {
                            results.push({
                                tag: el.tagName,
                                class: el.className,
                                role: el.getAttribute('role'),
                                href: el.getAttribute('href'),
                                text: el.textContent.trim().slice(0, 60),
                                id: el.id
                            });
                        }
                    });
                    return results.slice(0, 20);
                }
            """)
            print(f"\nElements with text '270' or 'CSCI 270':")
            for el in elements_info:
                print(f"  {el}")

            # Try clicking each one and watching for API calls
            print("\nTrying to click each '270' element...")
            count = await page.locator("text='270'").count()
            print(f"Playwright found {count} elements matching text='270'")

            for i in range(min(count, 5)):
                try:
                    loc = page.locator("text='270'").nth(i)
                    tag = await loc.evaluate("el => el.tagName")
                    cls = await loc.evaluate("el => el.className")
                    print(f"\n  Clicking element {i}: <{tag}> class='{cls}'")
                    await loc.scroll_into_view_if_needed()
                    await loc.click(timeout=3000)
                    await page.wait_for_timeout(3000)
                    if api_responses:
                        print("  -> API call triggered!")
                        break
                    print(f"  -> No new API call. URL: {page.url}")
                except Exception as e:
                    print(f"  -> Click failed: {e}")

        await browser.close()

    if api_responses:
        print("\n=== Captured API responses ===")
        for r in api_responses:
            print(f"\n{r['url']}")
            print(f"  {json.dumps(r['body'])[:800]}")
        with open("debug_api_calls.json", "w") as f:
            json.dump(api_responses, f, indent=2, default=str)
        print("\nSaved to debug_api_calls.json")

asyncio.run(main())
