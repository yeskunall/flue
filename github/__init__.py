"""Source that loads GitHub issues for a specific repository via GraphQL."""

from typing import Optional

import dlt
from dlt.sources import DltResource

from .helpers import get_reactions_data


@dlt.source
def github_issues(
    owner: str,
    name: str,
    access_token: str = dlt.secrets.value,
    items_per_page: int = 100,
    max_items: Optional[int] = None,
    states: Optional[list[str]] = None,
) -> DltResource:
    """Get issues from the repo `name` with owner `owner`.

    Args:
        owner (str): The repository owner
        name (str): The repository name
        access_token (str): The classic access token. Will be injected from secrets if not provided.
        items_per_page (int, optional): How many issues to get per page. Defaults to 100.
        max_items (int, optional): How many issues to get in total. None means all.
        states (list[str], optional): Filter by state. Options: ["OPEN"], ["CLOSED"], or None for all.

    Returns:
        DltResource: Issues resource
    """
    return dlt.resource(
        get_reactions_data(
            "issues",
            owner,
            name,
            access_token,
            items_per_page,
            max_items,
            states,
        ),
        name="issues",
        write_disposition="merge",
        primary_key="number",
    )
