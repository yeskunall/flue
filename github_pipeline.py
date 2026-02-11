import dlt

from github import github_issues


def load_zed_repo_issues() -> None:
    """Loads open issues for zed-industries/zed"""
    pipeline = dlt.pipeline(
        "github_issues",
        destination="duckdb",
        dataset_name="zed_issues",
    )
    data = github_issues("zed-industries", "zed", items_per_page=25)
    print(pipeline.run(data))


if __name__ == "__main__":
    load_zed_repo_issues()
