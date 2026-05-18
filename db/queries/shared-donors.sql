-- Shared-donor query: replaces Connection Mapper stage 1.
-- Parameter: ?  =  subject member_id (e.g. 'chuck-schumer')
--
-- Returns one row per peer who shares at least one donor (by canonical name).
-- The peer_amount + subject_amount are lifetime cumulative across cycles, so
-- "shared" here means "this entity wrote checks to both members at some point
-- in the loaded window." It is NOT a claim of simultaneous donation.

SELECT
  b.member_id   AS peer_id,
  m.name        AS peer_name,
  COUNT(*)      AS shared_count,
  SUM(a.amount + b.amount) AS combined_amount,
  LIST(a.donor_canonical ORDER BY a.amount + b.amount DESC) AS donor_canonicals
FROM donors a
JOIN donors b
  ON a.donor_canonical = b.donor_canonical
 AND a.member_id <> b.member_id
JOIN members m ON m.member_id = b.member_id
WHERE a.member_id = ?
GROUP BY b.member_id, m.name
ORDER BY shared_count DESC, combined_amount DESC;
