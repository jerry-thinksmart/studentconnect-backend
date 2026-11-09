ALTER TABLE posts ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

-- One row per (post, viewer) so repeated opens by the same student count once.
CREATE TABLE IF NOT EXISTS post_views (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS posts_public_view_idx ON posts(view_count DESC, created_at DESC) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS post_likes_post_idx ON post_likes(post_id);
