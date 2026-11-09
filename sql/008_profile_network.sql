ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS career_path text,
  ADD COLUMN IF NOT EXISTS institution text;

CREATE INDEX IF NOT EXISTS users_city_idx ON users (lower(trim(city))) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_country_idx ON users (lower(trim(country))) WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_career_path_idx ON users (lower(trim(career_path))) WHERE career_path IS NOT NULL;
