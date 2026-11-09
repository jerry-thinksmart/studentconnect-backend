CREATE TABLE IF NOT EXISTS post_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_images_post_idx ON post_images(post_id);
CREATE INDEX IF NOT EXISTS posts_media_recent_idx ON posts(created_at DESC) WHERE media_url IS NOT NULL AND visibility = 'public';
