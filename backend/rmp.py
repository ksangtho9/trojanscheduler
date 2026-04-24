# RateMyProfessor GraphQL fetcher
# fetch_rmp_scores(professor_names: list[str]) -> dict[str, RMPData]
# Session-level cache keyed by professor name to avoid duplicate calls
# Falls back to rating=3.0 with no_ratings=True if professor not found
