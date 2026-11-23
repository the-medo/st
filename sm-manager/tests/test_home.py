import unittest
from html.parser import HTMLParser

from sm_manager.home import external_url, service_cards


class Links(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links = []
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == "a":
            self.links.append(dict(attrs))


class HomeTests(unittest.TestCase):
    def test_configured_services_and_optional_integrations(self):
        html = service_cards({"home_links": [{"name": "Books", "url": "https://books.example.com", "icon": "headphones", "tone": "amber"}], "printer_url": "https://print.example.com", "dave_port": 18647})
        links = Links(html).links
        self.assertEqual([link["href"] for link in links], ["https://books.example.com", "https://print.example.com", "/planner/tasks", "/#air-quality", "/#faceplate", "#system"])
        for link in links[:2]:
            self.assertEqual(link["target"], "_blank")
            self.assertEqual(link["rel"], "noopener noreferrer")
            self.assertIn("opens in a new tab", link["aria-label"])
        self.assertTrue(all("target" not in link for link in links[2:]))
        self.assertEqual(len(Links(service_cards({})).links), 3)

    def test_invalid_links_are_skipped_and_config_text_cannot_become_markup(self):
        invalid = [None, 42, "javascript:alert(1)", "//outside.example", "http://outside.example", "https://", "https://user:secret@example.com", "https://example.com:bad", "https://example.com:99999", "https://example.com\n/path", "https://example.com\\evil"]
        for url in invalid:
            self.assertFalse(external_url(url), url)
        html = service_cards({"home_links": [None, *[{"name": "Invalid", "url": url} for url in invalid], {"name": '<script>alert("bad")</script>', "url": 'https://example.com/?q="&a=1', "description": '<img src=x onerror="bad">', "category": "<b>Bad</b>", "tone": [], "icon": {}}]})
        parsed = Links(html)
        self.assertEqual(len(parsed.links), 4)
        self.assertEqual(parsed.links[0]["href"], 'https://example.com/?q="&a=1')
        self.assertNotIn("script", parsed.tags)
        self.assertNotIn("img", parsed.tags)
        self.assertIn('class="service-card service-slate"', html)
        self.assertEqual(len(Links(service_cards({"home_links": "invalid"})).links), 3)


if __name__ == "__main__":
    unittest.main()
