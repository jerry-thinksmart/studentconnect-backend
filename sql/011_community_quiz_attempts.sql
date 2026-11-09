CREATE TABLE IF NOT EXISTS community_quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES community_quizzes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers jsonb NOT NULL,
  score integer NOT NULL CHECK (score >= 0),
  total integer NOT NULL CHECK (total > 0 AND score <= total),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quiz_id, user_id)
);
