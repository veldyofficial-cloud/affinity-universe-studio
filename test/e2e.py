"""Browser test against the local dev server (scripts/dev-server.mjs).

    ADMIN_PASSWORD=e2e-pass-123 SESSION_SECRET=... node scripts/dev-server.mjs 3917
    python test/e2e.py http://localhost:3917 e2e-pass-123
"""
import os
import struct
import sys
import zlib

from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3917"
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "e2e-pass-123"
SHOTS = os.path.join(os.path.dirname(__file__), "screens")
os.makedirs(SHOTS, exist_ok=True)
results = []


def step(name):
    print("..", name, flush=True)
    results.append(name)


def tiny_png(path):
    raw = b"".join(b"\x00" + bytes([200, 120, 40]) * 8 for _ in range(8))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    # ---------- admin ----------
    admin = browser.new_context()
    page = admin.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/admin/console")
    page.wait_for_url("**/admin/login?next=*")
    step("unauthenticated /admin/console redirects to /admin/login")

    page.fill("#password", "wrong")
    page.click("#loginForm button[type=submit]")
    expect(page.locator("#error")).to_contain_text("비밀번호가 올바르지 않습니다")
    step("wrong password rejected")

    page.fill("#password", PASSWORD)
    page.fill("#name", "E2E")
    page.click("#loginForm button[type=submit]")
    page.wait_for_url("**/admin/console")
    expect(page.locator("h1")).to_contain_text("상담부터 등록까지")
    step("admin login works; /admin/console loads leads view (asset rewrites under /admin ok)")

    page.goto(BASE + "/")
    expect(page.locator(".sidebar")).to_be_visible()
    logo_ok = page.evaluate("() => { const i = document.querySelector('.logo-badge img'); return i.complete && i.naturalWidth > 0 }")
    assert logo_ok, "logo should load from local assets/"
    page.screenshot(path=os.path.join(SHOTS, "01-admin-overview.png"), full_page=True)
    step("admin overview renders, local logo asset loads")

    # marketers & links
    page.click("[data-nav=links]")
    expect(page.locator("h1")).to_contain_text("같은 페이지")
    page.click("#newMarketer")
    page.fill("#marketerName", "마케터 E2E")
    page.click("#saveForm button[type=submit]")
    expect(page.locator("#toast")).to_contain_text("마케터를 저장했습니다")
    page.click("#newLink")
    page.fill("#linkLabel", "E2E 대표 링크")
    page.click("#saveForm button[type=submit]")
    expect(page.locator("#toast")).to_contain_text("유입 링크를 저장했습니다")
    expect(page.locator("text=E2E 대표 링크")).to_be_visible()
    code = page.evaluate("async () => (await (await fetch('/api/admin/links')).json()).links[0].code")
    page.screenshot(path=os.path.join(SHOTS, "02-links.png"), full_page=True)
    step(f"marketer + link creation works (code {code})")

    # page editor: upload media + publish
    page.click("[data-nav=page]")
    expect(page.locator("#publishPage")).to_be_visible()
    png = os.path.join(SHOTS, "course.png")
    tiny_png(png)
    page.set_input_files("#media0", png)
    expect(page.locator("#toast")).to_contain_text("미디어를 첨부했습니다")
    expect(page.locator(".attachment-card")).to_have_count(1)
    page.fill("#pageTitle", "E2E 발행 제목")
    page.click("#publishPage")
    expect(page.locator("#toast")).to_contain_text("고객용 페이지에 발행했습니다")
    step("media upload (raw POST) + publish works")

    # ---------- visitor ----------
    visitor = browser.new_context(timezone_id="Asia/Seoul")
    v = visitor.new_page()
    v.on("pageerror", lambda e: errors.append("visitor: " + str(e)))
    v.goto(f"{BASE}/consult?ref={code}&utm_source=instagram")
    expect(v.locator(".phonehead h2")).to_contain_text("E2E 발행 제목")
    v.wait_for_function("() => [...document.querySelectorAll('img.course-media')].some(i => i.complete && i.naturalWidth > 0)")
    v.screenshot(path=os.path.join(SHOTS, "03-visitor.png"), full_page=True)
    step("visitor /consult loads published page and course media via /api/media/:id")

    pub = v.evaluate("async () => (await (await fetch('/api/public')).json())")
    assert pub["admin"] is False
    st = v.evaluate("async () => (await fetch('/api/admin/state')).status")
    assert st == 403, st
    put = v.evaluate("async () => (await fetch('/api/admin/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:'{}'})).status")
    assert put == 403, put
    step("visitor gets admin:false and 403 on admin APIs")

    v.click("#requestConsult")
    expect(v.locator("#saveLead")).to_be_visible()
    v.fill("#leadName", "방문 고객")
    v.fill("#leadPhone", "010-1234-5678")
    v.select_option("#residenceCountry", "KR")
    v.fill("#residenceRegion", "서울특별시")
    v.select_option("#residenceTimezone", "Asia/Seoul")
    v.check("#residenceConfirmed")
    v.select_option("#leadSource", "인스타그램")
    v.fill("#leadMessage", "아트북 수업이 궁금합니다")
    v.check("#contactConsent")
    v.screenshot(path=os.path.join(SHOTS, "04-inquiry-form.png"), full_page=True)
    v.click("#saveLead button[type=submit]")
    expect(v.locator("#toast")).to_contain_text("상담 신청이 접수되었습니다")
    step("visitor inquiry submit works")

    # ---------- admin sees the lead ----------
    page.click("[data-nav=leads]")
    row = page.locator("tr", has_text="방문 고객")
    expect(row).to_be_visible()
    expect(row).to_contain_text("마케터 E2E")
    expect(row).to_contain_text("인스타그램")
    expect(row).to_contain_text("대한민국")
    page.screenshot(path=os.path.join(SHOTS, "05-leads.png"), full_page=True)
    step("admin console lists the new lead with marketer, channel, location")

    row.locator("[data-detail]").click()
    page.select_option("#op-status", "상담 중")
    page.fill("#op-amount", "300000")
    page.click("#saveOperations button[type=submit]")
    expect(page.locator("#toast")).to_contain_text("사이트에 저장했습니다")
    page.locator("tr", has_text="방문 고객").locator("[data-detail]").click()
    page.click("#leadHistory")
    expect(page.locator("#modal")).to_contain_text("관리자 · E2E")
    page.keyboard.press("Escape")
    step("lead detail save + change history work")

    page.click("[data-nav=links]")
    expect(page.locator("tbody tr", has_text="E2E 대표 링크")).to_contain_text("1 / 0")
    step("link stats show 1 inquiry")

    page.click("[data-nav=settings]")
    page.click("#checkMondaySettings")
    expect(page.locator("#mondaySettingsOutcome")).to_contain_text("환경 변수가 설정되지 않았습니다")
    step("Monday check shows clear 'not configured' message")

    with page.expect_download() as d:
        page.click("#backup")
    assert d.value.suggested_filename == "affinity-studio-backup.json"
    step("backup download works")

    assert not errors, errors
    browser.close()

print("\nALL E2E STEPS PASSED:")
for r in results:
    print(" -", r)
