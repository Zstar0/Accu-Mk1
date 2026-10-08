"""Fixed, read-only Plain GraphQL queries (spec 3.2). The client sends nothing else."""

WORKSPACE = "query Workspace { myWorkspace { id } }"

CUSTOMER_BY_EMAIL = """query CustomerByEmail($email: String!) {
  customerByEmail(email: $email) { id fullName }
}"""

_THREAD_FIELDS = """id ref title previewText status priority isTestThread
      createdAt { iso8601 }
      updatedAt { iso8601 }
      customer { id fullName }
      labels { labelType { name } }
      assignedTo { __typename ... on User { fullName } ... on MachineUser { fullName } }
      lastInboundMessageInfo { timestamp { iso8601 } }
      lastOutboundMessageInfo { timestamp { iso8601 } }"""

THREADS = """query CustomerThreads($customerIds: [ID!]!, $after: String) {
  threads(first: 50, after: $after, filters: {customerIds: $customerIds, isMarkedAsSpam: false}) {
    pageInfo { hasNextPage endCursor }
    edges { node { %s } }
  }
}""" % _THREAD_FIELDS

_ACTOR = """__typename
        ... on UserActor { user { fullName } }
        ... on CustomerActor { customer { fullName } }
        ... on MachineUserActor { machineUser { fullName } }"""

# `text` is aliased per entry type: Plain declares it String on some and String! on others,
# which GraphQL rejects as a field conflict in one selection.
THREAD = """query Thread($threadId: ID!, $after: String) {
  thread(threadId: $threadId) {
    %s
    timelineEntries(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        timestamp { iso8601 }
        actor { %s }
        entry {
          __typename
          ... on EmailEntry { subject textContent hasMoreTextContent fullTextContent from { name email } }
          ... on ChatEntry { chatText: text }
          ... on NoteEntry { noteText: text }
          ... on SlackMessageEntry { slackText: text }
          ... on SlackReplyEntry { slackReplyText: text }
          ... on ThreadDiscussionMessageEntry { discussionText: text }
          ... on CustomEntry { title components { __typename ... on ComponentText { text } } }
          ... on ThreadStatusTransitionedEntry { nextStatus }
          ... on ThreadLabelsChangedEntry { nextLabels { labelType { name } } }
          ... on ThreadAssignmentTransitionedEntry { nextAssignee { __typename ... on User { fullName } ... on MachineUser { fullName } } }
          ... on ThreadPriorityChangedEntry { nextPriority }
        }
      } }
    }
  }
}""" % (_THREAD_FIELDS, _ACTOR)

ALL = frozenset({WORKSPACE, CUSTOMER_BY_EMAIL, THREADS, THREAD})
