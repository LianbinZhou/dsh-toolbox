/**
 * A REAL archive snapshot, captured from a live web profile (2026-10-17).
 *
 * Pi's point: scanning session DIRECTORY names proves nothing, because the delete
 * route receives ids from `global.archivedSessionIds`, which also contains ids whose
 * directory was removed long ago. These are the ids that must survive the allowlist.
 *
 * Only ids are recorded here: no titles, no paths, no content.
 */

export const REAL_ARCHIVED_IDS = [
  'session-91457d7d-8938-4344-81ff-584a17514204',
  'session-18d742b2-0fb1-401a-bcb2-715541264d6e',
  'session-47855b41-f62c-4768-818a-0dc09bf1a2cd',
  'session-a258ddba-18b7-4b64-88f9-1a911b2bdd66',
  'session-bcc284bc-6492-4eba-8fd8-2f53d2ddaf86',
  'session-9001f4dd-12c3-4a64-b928-a910802931b8',
  'session-67c03d9d-e723-4386-ae66-421fa1857968',
  'session-12237fb9-29fe-4a2e-9254-c4f320e91219',
  'session-c601bc31-a533-4b8d-ba35-da0b920274da',
  'session-d7979a06-e834-4c5c-ac38-c60d3cc3822f',
  'session-e637eb69-d0eb-4081-8525-81d43c1f053f',
  'session-13820fee-33d7-4bbe-8f72-4cfccab18cdf',
  'session-69bdb619-596c-4978-a202-68a73d08e5b2',
  'session-95d39b10-6abf-4200-999c-1392eb4e266b',
  'session-76d1fd61-29f6-43c6-88aa-ca5463e14737',
  'session-ca2f7d32-df39-430b-80f0-197556235096',
  'session-17f5f4ba-de9f-43f6-b625-b970ebdf0541',
  'session-d2d31feb-b53a-427c-afa0-13f0ef408afa',
  'session-a7f75c8a-3379-40c9-b5db-46c5cdc88cb0',
  'session-569b2956-0a73-430f-b3c1-d6fb9d5ee0f8',
  'session-13429083-403a-4fc0-9092-7b7c62d10799',
  'session-b0180de6-24fa-45db-9ef3-04327aadca7c',
  'session-18ea1e61-0a48-496f-a3b9-2ad2b2676f54',
  'session-22e2ff2e-b81a-4f25-b72a-e02d60c06159',
  'session-f03a29d3-07f7-4b49-aa19-d7418e4091d8',
  'session-e3232b7c-7179-4f18-b371-86fda6e01792',
  'session-c26edbcf-66f2-4924-8210-87b4bd475f17',
  'session-9f13cdd9-0507-413c-ada0-6d1602439014',
  'session-25863598-94ae-4006-a91b-e87cf397ed44',
  'session-8cbc91c1-07fe-49eb-b309-b0feeec59362',
  'session-9cbbe426-7ea4-435c-9dcf-0afe393115e1',
  'session-321308cb-d91f-4c96-a9f8-2538d6fdf626',
  'session-0962fe08-9f35-4d76-84ff-bf168a1555b4',
  'session-2800bea7-5c0f-4140-8ac4-4a7b6cda33d3',
]

/** The subset whose session directory no longer exists ("ghosts"). */
export const REAL_GHOST_IDS = [
  'session-0962fe08-9f35-4d76-84ff-bf168a1555b4',
  'session-2800bea7-5c0f-4140-8ac4-4a7b6cda33d3',
]

/** Captured at a moment when every archived id used this one spelling. */
export const REAL_ARCHIVED_COUNT = 34

