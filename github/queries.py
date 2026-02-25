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
        id
        databaseId
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
        stateReason
        updatedAt
        locked
        activeLockReason
        isPinned
        createdViaEmail
        includesCreatedEdit
        lastEditedAt
        publishedAt
        trackedIssuesCount
        editor { login avatarUrl url }
        duplicateOf { number url title }
        parent { number url title }
        issueType { id name description color }
        labels(first: 10) { nodes { name color description } }
        assignees(first: 10) { nodes { login avatarUrl url } }
        closedEvents: timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
          nodes {
            ... on ClosedEvent {
              actor { login url }
              createdAt
              closer {
                ... on PullRequest { number url title }
                ... on Commit { oid url }
              }
            }
          }
        }
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