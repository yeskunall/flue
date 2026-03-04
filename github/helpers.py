import time
from typing import Iterator, List, Optional, Tuple

import dlt
from dlt.common.typing import DictStrAny, StrAny
from dlt.common.utils import chunks
from dlt.sources.helpers import requests
from requests.exceptions import HTTPError, ConnectionError

from .queries import COMMENT_REACTIONS_QUERY, ISSUES_QUERY, RATE_LIMIT
from .settings import GRAPHQL_API_BASE_URL, REST_API_BASE_URL


#
# Shared
#
def _get_auth_header(access_token: Optional[str]) -> StrAny:
    if access_token:
        return {"Authorization": f"Bearer {access_token}"}
    else:
        # REST API works without access token (with high rate limits)
        return {}


#
# Rest API helpers
#
def get_rest_pages(access_token: Optional[str], query: str) -> Iterator[List[StrAny]]:
    def _request(page_url: str) -> requests.Response:
        r = requests.get(page_url, headers=_get_auth_header(access_token), timeout=30)
        print(
            f"got page {page_url}, requests left: " + r.headers["x-ratelimit-remaining"]
        )
        return r

    next_page_url = REST_API_BASE_URL + query
    while True:
        r: requests.Response = _request(next_page_url)
        page_items = r.json()
        if len(page_items) == 0:
            break
        yield page_items
        if "next" not in r.links:
            break
        next_page_url = r.links["next"]["url"]


#
# GraphQL API helpers
#
def get_reactions_data(
    node_type: str,
    owner: str,
    name: str,
    access_token: str,
    items_per_page: int,
    max_items: Optional[int],
    states: Optional[List[str]] = None,
    updated_at: dlt.sources.incremental[str] = dlt.sources.incremental(
        "updatedAt", initial_value="1970-01-01T00:00:00Z"
    ),
) -> Iterator[Iterator[StrAny]]:
    variables = {
        "owner": owner,
        "name": name,
        "issues_per_page": items_per_page,
        "first_reactions": 100,
        "first_comments": 100,
        "node_type": node_type,
        "since": updated_at.start_value,
    }
    if states:
        variables["states"] = states
    for page_items in _get_graphql_pages(
        access_token, ISSUES_QUERY % node_type, variables, node_type, max_items
    ):
        # use reactionGroups to query for reactions to comments that have any reactions. reduces cost by 10-50x
        reacted_comment_ids = {}
        for item in page_items:
            for comment in item["comments"]["nodes"]:
                if any(group["createdAt"] for group in comment["reactionGroups"]):
                    # print(f"for comment {comment['id']}: has reaction")
                    reacted_comment_ids[comment["id"]] = comment
                # if "reactionGroups" in comment:
                comment.pop("reactionGroups", None)

        # get comment reactions by querying comment nodes separately
        comment_reactions = _get_comment_reaction(
            list(reacted_comment_ids.keys()), access_token
        )
        # attach the reaction nodes where they should be
        for comment in comment_reactions.values():
            comment_id = comment["id"]
            reacted_comment_ids[comment_id]["reactions"] = comment["reactions"]
        yield map(_extract_nested_nodes, page_items)


def _extract_top_connection(data: StrAny, node_type: str) -> StrAny:
    assert (
        isinstance(data, dict) and len(data) == 1
    ), f"The data with list of {node_type} must be a dictionary and contain only one element"
    data = next(iter(data.values()))
    return data[node_type]  # type: ignore


def _extract_nested_nodes(item: DictStrAny) -> DictStrAny:
    """Recursively moves `nodes` and `totalCount` to reduce nesting."""
    item["reactions_totalCount"] = item["reactions"].get("totalCount", 0)
    item["reactions"] = item["reactions"]["nodes"]
    comments = item["comments"]
    item["comments_totalCount"] = item["comments"].get("totalCount", 0)
    for comment in comments["nodes"]:
        if "reactions" in comment:
            comment["reactions_totalCount"] = comment["reactions"].get("totalCount", 0)
            comment["reactions"] = comment["reactions"]["nodes"]
    item["comments"] = comments["nodes"]
    if "labels" in item and isinstance(item["labels"], dict):
        item["labels"] = item["labels"].get("nodes", [])
    if "assignees" in item and isinstance(item["assignees"], dict):
        item["assignees"] = item["assignees"].get("nodes", [])
    if "closedEvents" in item and isinstance(item["closedEvents"], dict):
        item["closedEvents"] = item["closedEvents"].get("nodes", [])
    if "labeledEvents" in item and isinstance(item["labeledEvents"], dict):
        item["labeledEvents"] = item["labeledEvents"].get("nodes", [])
    if "unlabeledEvents" in item and isinstance(item["unlabeledEvents"], dict):
        item["unlabeledEvents"] = item["unlabeledEvents"].get("nodes", [])
    return item


def _get_reset_wait_time(response) -> int:
    """Get seconds to wait until rate limit resets."""
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        return int(retry_after) + 1
    
    reset_time = response.headers.get("x-ratelimit-reset")
    if reset_time:
        return max(0, int(reset_time) - int(time.time())) + 1
    
    return 60  # Default fallback


def _is_rate_limit_error(e: Exception) -> bool:
    """Check if the error is a rate limit error (should wait and retry indefinitely)."""
    if hasattr(e, 'response') and e.response is not None:
        return e.response.status_code in (403, 429)
    return False


def _is_transient_error(e: Exception) -> bool:
    """Check if the error is transient (should retry with backoff)."""
    if isinstance(e, ConnectionError):
        return True
    if hasattr(e, 'response') and e.response is not None:
        return e.response.status_code in (500, 502, 503, 504)
    return False


def _is_graphql_rate_limit(data: dict, response) -> bool:
    """Check if a GraphQL 200 response is actually a rate limit error."""
    errors = data.get("errors", [])
    if any(e.get("type") == "RATE_LIMITED" for e in errors):
        return True
    remaining = response.headers.get("x-ratelimit-remaining")
    if remaining is not None and int(remaining) == 0:
        return True
    return False


def _run_graphql_query(
    access_token: str, query: str, variables: DictStrAny, max_transient_retries: int = 10
) -> Tuple[StrAny, StrAny]:
    transient_failures = 0
    
    while True:
        try:
            r = requests.post(
                GRAPHQL_API_BASE_URL,
                json={"query": query, "variables": variables},
                headers=_get_auth_header(access_token),
                timeout=30,
            )
            r.raise_for_status()

            data = r.json()
            if "errors" in data:
                if _is_graphql_rate_limit(data, r):
                    wait_time = _get_reset_wait_time(r)
                    print(f"GraphQL rate limited. Waiting {wait_time}s until reset...")
                    time.sleep(wait_time)
                    continue
                raise ValueError(data)
            data = data["data"]
            # pop rate limits
            rate_limit = data.pop("rateLimit", {"cost": 0, "remaining": 0})
            
            # Proactively wait if we're running low on credits
            remaining = rate_limit.get("remaining", 5000)
            if remaining < 50:
                reset_at = rate_limit.get("resetAt")
                if reset_at:
                    from datetime import datetime
                    reset_time = datetime.fromisoformat(reset_at.replace("Z", "+00:00")).timestamp()
                    wait_seconds = max(0, int(reset_time - time.time())) + 1
                    print(f"Rate limit low ({remaining} remaining), waiting {wait_seconds}s until reset...")
                    time.sleep(wait_seconds)
            
            return data, rate_limit
            
        except (HTTPError, ConnectionError) as e:
            if _is_rate_limit_error(e):
                # Rate limit: wait for reset and retry indefinitely
                wait_time = _get_reset_wait_time(e.response)
                print(f"Rate limited. Waiting {wait_time}s until reset...")
                time.sleep(wait_time)
                # Don't increment failure count — this is expected behavior
                
            elif _is_transient_error(e):
                # Transient error: retry with backoff, but give up eventually
                transient_failures += 1
                if transient_failures > max_transient_retries:
                    print(f"Too many transient failures ({transient_failures}), giving up.")
                    raise
                wait_time = min(2 ** transient_failures, 60)  # Cap at 60s
                print(f"Transient error ({e}), retrying in {wait_time}s... (failure {transient_failures}/{max_transient_retries})")
                time.sleep(wait_time)
                
            else:
                # Unknown error: fail immediately
                raise


def _get_graphql_pages(
    access_token: str, query: str, variables: DictStrAny, node_type: str, max_items: int
) -> Iterator[List[DictStrAny]]:
    items_count = 0
    while True:
        data, rate_limit = _run_graphql_query(access_token, query, variables)
        top_connection = _extract_top_connection(data, node_type)
        data_items = (
            top_connection["nodes"]
            if "nodes" in top_connection
            else top_connection["edges"]
        )
        items_count += len(data_items)
        print(
            f'Got {len(data_items)}/{items_count} {node_type}s, query cost {rate_limit["cost"]}, remaining credits: {rate_limit["remaining"]}'
        )
        if data_items:
            yield data_items
        else:
            return
        # print(data["repository"][node_type]["pageInfo"]["endCursor"])
        variables["page_after"] = _extract_top_connection(data, node_type)["pageInfo"][
            "endCursor"
        ]
        if max_items and items_count >= max_items:
            print(f"Max items limit reached: {items_count} >= {max_items}")
            return


def _get_comment_reaction(comment_ids: List[str], access_token: str) -> StrAny:
    """Builds a query from a list of comment nodes and returns associated reactions."""
    idx = 0
    data: DictStrAny = {}
    for page_chunk in chunks(comment_ids, 50):
        subs = []
        for comment_id in page_chunk:
            subs.append(COMMENT_REACTIONS_QUERY % (idx, comment_id))
            idx += 1
        subs.append(RATE_LIMIT)
        query = "{" + ",\n".join(subs) + "}"
        # print(query)
        page, rate_limit = _run_graphql_query(access_token, query, {})
        print(
            f'Got {len(page)} comments, query cost {rate_limit["cost"]}, remaining credits: {rate_limit["remaining"]}'
        )
        data.update(page)
    return data
