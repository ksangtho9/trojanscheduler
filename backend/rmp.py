import asyncio
import base64
import httpx
from typing import Optional

RMP_ENDPOINT = "https://www.ratemyprofessors.com/graphql"
RMP_AUTH = "Basic dGVzdDp0ZXN0"   # base64("test:test") — RMP's public token
USC_SCHOOL_ID = "U2Nob29sLTEwNTk="  # base64("School-1059")

_SEARCH_QUERY = """
query SearchTeachersQuery($text: String!, $schoolID: ID) {
  newSearch {
    teachers(query: {text: $text, schoolID: $schoolID}) {
      edges {
        node {
          id
          firstName
          lastName
          avgRating
          avgDifficulty
          wouldTakeAgainPercent
          numRatings
        }
      }
    }
  }
}
"""


def _decode_rmp_id(encoded_id: str) -> str:
    """'VGVhY2hlci0xMjM0NTY=' → '123456'"""
    try:
        return base64.b64decode(encoded_id).decode().rsplit("-", 1)[-1]
    except Exception:
        return ""


def _best_match(edges: list[dict], professor_name: str) -> Optional[dict]:
    """
    Pick the best-matching node from RMP results.
    Scores: last-name match = 2 pts, first-name match = 1 pt.
    Falls back to first result if nothing scores.
    """
    parts = professor_name.lower().split()
    last = parts[-1] if parts else ""
    first = parts[0] if len(parts) > 1 else ""

    best_node, best_score = None, 0
    for edge in edges:
        node = edge.get("node", {})
        node_last = (node.get("lastName") or "").lower()
        node_first = (node.get("firstName") or "").lower()

        score = 0
        if last and last in node_last:
            score += 2
        if first and first in node_first:
            score += 1

        if score > best_score:
            best_score = score
            best_node = node

    if best_node and best_score > 0:
        return best_node
    return edges[0]["node"] if edges else None


def _no_data() -> dict:
    return {
        "rmp_score": 3.0,
        "rmp_difficulty": None,
        "would_take_again": None,
        "rmp_total_ratings": 0,
        "rmp_profile_url": None,
        "no_rmp_data": True,
    }


def _float_or_none(val) -> Optional[float]:
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


async def fetch_rmp(professor_name: str, client: httpx.AsyncClient) -> dict:
    """
    Fetch RMP data for one professor at USC.
    Returns a dict of rmp_* fields ready to apply to a Section.
    Always returns something safe — never raises.
    """
    if not professor_name or professor_name == "TBA":
        return _no_data()

    last_name = professor_name.strip().split()[-1]

    try:
        r = await client.post(
            RMP_ENDPOINT,
            json={
                "query": _SEARCH_QUERY,
                "variables": {"text": last_name, "schoolID": USC_SCHOOL_ID},
            },
            headers={
                "Authorization": RMP_AUTH,
                "Content-Type": "application/json",
                "Referer": "https://www.ratemyprofessors.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            timeout=10.0,
        )
        r.raise_for_status()
        edges = (
            r.json()
            .get("data", {})
            .get("newSearch", {})
            .get("teachers", {})
            .get("edges", [])
        )
    except Exception:
        return _no_data()

    if not edges:
        return _no_data()

    node = _best_match(edges, professor_name)
    if not node:
        return _no_data()

    numeric_id = _decode_rmp_id(node.get("id", ""))
    return {
        "rmp_score":         float(node.get("avgRating") or 3.0),
        "rmp_difficulty":    _float_or_none(node.get("avgDifficulty")),
        "would_take_again":  _float_or_none(node.get("wouldTakeAgainPercent")),
        "rmp_total_ratings": int(node.get("numRatings") or 0),
        "rmp_profile_url": (
            f"https://www.ratemyprofessors.com/professor/{numeric_id}"
            if numeric_id else None
        ),
        "no_rmp_data": False,
    }


async def fetch_rmp_scores(
    professor_names: list[str],
    client: httpx.AsyncClient,
    concurrency: int = 5,
) -> dict[str, dict]:
    """
    Fetch RMP data for a list of professor names.
    Returns {professor_name: rmp_data_dict}.
    Deduplicates automatically — one API call per unique name.
    """
    unique = list(set(professor_names))
    semaphore = asyncio.Semaphore(concurrency)
    cache: dict[str, dict] = {}

    async def _fetch_one(name: str) -> None:
        async with semaphore:
            cache[name] = await fetch_rmp(name, client)

    await asyncio.gather(*[_fetch_one(p) for p in unique])
    return cache


async def enrich_with_rmp(
    all_sections: dict,
    client: httpx.AsyncClient,
    concurrency: int = 5,
) -> None:
    """
    Mutates Section objects in place with RMP data.
    all_sections: course_code -> list[Section]
    """
    flat = [s for sections in all_sections.values() for s in sections]
    names = [s.professor for s in flat if s.professor not in ("TBA", "")]

    cache = await fetch_rmp_scores(names, client, concurrency)

    for section in flat:
        data = cache.get(section.professor, _no_data())
        section.rmp_score         = data["rmp_score"]
        section.rmp_difficulty    = data["rmp_difficulty"]
        section.would_take_again  = data["would_take_again"]
        section.rmp_total_ratings = data["rmp_total_ratings"]
        section.rmp_profile_url   = data["rmp_profile_url"]
        section.no_rmp_data       = data["no_rmp_data"]
