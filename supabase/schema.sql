-- Projects table
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  title text,
  status text default 'draft' check (status in ('draft','processing','images_ready','generating_videos','videos_ready','assembling','complete','error')),
  script text,
  brief jsonb,
  cost_cents integer,
  thumbnail_url text,
  video_url text,
  audio_url text,
  assembly_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Scenes table
create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  scene_index integer not null,
  description text,
  image_prompt text,
  motion_prompt text,
  image_url text,
  video_url text,
  video_request_id text,
  status text default 'pending' check (status in ('pending','generating_image','generating_video','complete','error')),
  created_at timestamptz default now()
);

-- RLS policies
alter table public.projects enable row level security;
alter table public.scenes enable row level security;

create policy "Users can manage their own projects"
  on public.projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can manage scenes for their projects"
  on public.scenes for all
  using (
    exists (
      select 1 from public.projects p
      where p.id = scenes.project_id and p.user_id = auth.uid()
    )
  );

-- Storage bucket for project assets
insert into storage.buckets (id, name, public)
  values ('project-assets', 'project-assets', true)
  on conflict do nothing;

create policy "Users can upload to their project folder"
  on storage.objects for insert
  with check (bucket_id = 'project-assets' and auth.uid() is not null);

create policy "Public can read project assets"
  on storage.objects for select
  using (bucket_id = 'project-assets');

create policy "Users can update their own assets"
  on storage.objects for update
  using (bucket_id = 'project-assets' and auth.uid() is not null);

create policy "Users can delete their own assets"
  on storage.objects for delete
  using (bucket_id = 'project-assets' and auth.uid() is not null);
