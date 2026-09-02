-- When an account first came alive, which is the only moment worth counting
-- as a signup.
--
-- `created_at` is written the instant an address is typed into the sign-in
-- form, so it counts intentions, including the ones that never opened the
-- email. `activated_at` is written when a magic link is actually redeemed,
-- once and never again: a visitor who asks for three links and clicks one is
-- one signup, and every later sign-in is not a signup at all. Ad reporting is
-- only as honest as this distinction.
ALTER TABLE users ADD COLUMN activated_at INTEGER;

-- Every account that already exists has already signed in, so it is dated
-- here rather than left NULL. Left NULL, the next time one of them followed
-- a sign-in link it would look like a first activation and report a signup
-- that never happened — on the day the ads go live, when the numbers are
-- being read most closely. `created_at` is not the true activation date, but
-- it is the closest thing on the row and it is in the past, which is what
-- matters: the account is spent, and cannot be counted again.
--
-- This runs once, against the rows that exist at upgrade time. Accounts
-- created afterwards start NULL and are dated by their real activation.
UPDATE users SET activated_at = created_at WHERE activated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_activated ON users(activated_at);
