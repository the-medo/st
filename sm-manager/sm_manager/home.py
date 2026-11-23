"""Home service cards. Private destinations belong in the local configuration."""

from html import escape
from urllib.parse import urlsplit

ICONS = {"headphones", "printer", "calendar", "air", "screen", "system", "link"}
TONES = {"amber", "coral", "violet", "mint", "blue", "slate"}


def external_url(value):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
        return False
    try:
        url = urlsplit(value)
        url.port  # Reject malformed or out-of-range ports before making a link.
        return url.scheme == "https" and bool(url.hostname) and not url.username and not url.password
    except ValueError:
        return False


def service_cards(config):
    services = []
    links = config.get("home_links", [])
    for link in links if isinstance(links, list) else []:
        if not isinstance(link, dict) or not external_url(link.get("url")) or not isinstance(link.get("name"), str) or not link["name"].strip():
            continue
        services.append({
            "name": link["name"], "url": link["url"],
            "description": str(link.get("description", "Open your service.")),
            "category": str(link.get("category", "Service")),
            "icon": link.get("icon") if isinstance(link.get("icon"), str) and link["icon"] in ICONS else "link",
            "tone": link.get("tone") if isinstance(link.get("tone"), str) and link["tone"] in TONES else "slate",
        })
    if external_url(config.get("printer_url")):
        services.append(dict(name="Prusa Local", url=config["printer_url"], description="Your printer, files and the things you’re making.", category="Make", icon="printer", tone="coral"))
    if config.get("dave_port"):
        services.append(dict(name="Planner", url="/planner/tasks", description="Tasks and calendar. A little space to plan ahead.", category="Organize", icon="calendar", tone="violet", destination="Tasks & calendar"))
    services.extend([
        dict(name="Air quality", url="/#air-quality", description="CO₂, temperature and the air around you.", category="Breathe", icon="air", tone="mint", destination="Indoor environment"),
        dict(name="Faceplate", url="/#faceplate", description="Your room display, with night mode a tap away.", category="At home", icon="screen", tone="blue", destination="Room display"),
        dict(name="System monitor", url="#system", description="Projects, containers and the machine behind it all.", category="Under the hood", icon="system", tone="slate", destination="Resources & activity"),
    ])
    cards = []
    for service in services:
        external = external_url(service["url"])
        destination = urlsplit(service["url"]).netloc if external else service["destination"]
        target = ' target="_blank" rel="noopener noreferrer"' if external else ""
        label = f'{service["name"]} (opens in a new tab)' if external else service["name"]
        icon = f'<svg viewBox="0 0 48 48" aria-hidden="true"><use href="/home-icons.svg#{service["icon"]}"></use></svg>'
        cards.append(f'''<a class="service-card service-{service['tone']}" href="{escape(service['url'], quote=True)}" aria-label="{escape(label, quote=True)}"{target}>
          <div class="service-card-top"><span class="service-icon">{icon}</span><span class="service-category">{escape(service['category'])}</span></div>
          <span class="service-art" aria-hidden="true">{icon}</span>
          <h3>{escape(service['name'])}</h3>
          <p>{escape(service['description'])}</p>
          <div class="service-card-bottom"><span>{escape(destination)}</span><span class="service-open">{'New tab' if external else 'Open'}</span></div>
        </a>''')
    return "\n".join(cards)
