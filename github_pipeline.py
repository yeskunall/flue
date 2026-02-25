import os
import sys

import dlt

from github import github_issues

DEFAULT_DB_PATH = os.path.join(
    os.path.expanduser("~"), "dev", "remote", "github.com", "yeskunall", "oncall", "github_issues.duckdb"
)


def load_zed_repo_issues(backfill: bool = False) -> None:
    """Loads open issues for zed-industries/zed"""
    db_path = os.environ.get("DUCKDB_PATH", DEFAULT_DB_PATH)
    pipeline = dlt.pipeline(
        "github_issues",
        destination=dlt.destinations.duckdb(db_path),
        dataset_name="zed_issues",
    )
    data = github_issues("zed-industries", "zed", items_per_page=25)
    run_kwargs = {"loader_file_format": "parquet"}
    if backfill:
        run_kwargs["refresh"] = "drop_sources"
    print(pipeline.run(data, **run_kwargs))


if __name__ == "__main__":
    load_zed_repo_issues(backfill="--backfill" in sys.argv)
