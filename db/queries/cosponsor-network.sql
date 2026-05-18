-- Co-sponsorship network edges.
--
-- An edge (a, b) exists when members a and b both appear on the same bill_id,
-- regardless of sponsor vs cosponsor role. Weight = number of shared bills.
--
-- Self-loops excluded. Each pair appears once (a < b alphabetically) so the
-- result is an undirected edge list the renderer can use directly.
--
-- Parameters: none (corpus-wide).

SELECT
  a.member_id   AS source_id,
  ms.name       AS source_name,
  ms.party      AS source_party,
  b.member_id   AS target_id,
  mt.name       AS target_name,
  mt.party      AS target_party,
  COUNT(*)      AS shared_bills,
  LIST(a.bill_id ORDER BY a.bill_id) AS bill_ids,
  LIST(COALESCE(a.title, '') ORDER BY a.bill_id) AS bill_titles
FROM bills a
JOIN bills b
  ON a.bill_id = b.bill_id
 AND a.member_id < b.member_id
JOIN members ms ON ms.member_id = a.member_id
JOIN members mt ON mt.member_id = b.member_id
GROUP BY a.member_id, ms.name, ms.party, b.member_id, mt.name, mt.party
ORDER BY shared_bills DESC;
