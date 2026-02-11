RATE_LIMIT = """
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
"""

ISSUES_QUERY = """
query($owner: String!, $name: String!, $issues_per_page: Int!, $first_reactions: Int!, $first_comments: Int!, $page_after: String, $states: [IssueState!], $since: DateTime) {
  repository(owner: $owner, name: $name) {
    %s(first: $issues_per_page, orderBy: {field: UPDATED_AT, direction: DESC}, after: $page_after, states: $states, filterBy: {since: $since}) {
      totalCount
      pageInfo {
        endCursor
        startCursor
      }
      nodes {
        # id
        number
        url
        title
        body
        author {login avatarUrl url}
        authorAssociation
        closed
        closedAt
        createdAt
        state
        updatedAt
        labels(first: 10) { nodes { name color description } }
        assignees(first: 10) { nodes { login avatarUrl url } }
        milestone { number title state dueOn }
        reactions(first: $first_reactions) {
          totalCount
          nodes {
            # id
            user {login avatarUrl url}
            content
            createdAt
          }
        }
        comments(first: $first_comments) {
          totalCount
          nodes {
            id
            url
            body
            author {avatarUrl login url}
            authorAssociation
            createdAt
            reactionGroups {content createdAt}
            # reactions(first: 0) {
            #   totalCount
            #   nodes {
            #     # id
            #     user {login avatarUrl url}
            #     content
            #     createdAt
            #   }
            # }
          }
        }
      }
    }
  }
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
}
"""

COMMENT_REACTIONS_QUERY = """
node_%s: node(id:"%s") {
     ... on IssueComment {
      id
      reactions(first: 100) {
        totalCount
        nodes {
            user {login avatarUrl url}
            content
            createdAt
          }
      }
    }
  }
"""

STARGAZERS_QUERY = """
query($owner: String!, $name: String!, $items_per_page: Int!, $page_after: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: $items_per_page, orderBy: {field: STARRED_AT, direction: DESC}, after: $page_after) {
      pageInfo {
        endCursor
        startCursor
      }
      edges {
        starredAt
        node {
          login
          avatarUrl
          url
        }
      }
    }
  }
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
}
"""
