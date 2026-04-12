-- SpeakNote 同期用テーブル
-- Supabase SQL Editor で実行

-- user_dataテーブル: 辞書・メモ・履歴・設定を1ユーザー1行で保存
create table if not exists user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dict jsonb default '[]'::jsonb,         -- 辞書 [{from, to}, ...]
  memos jsonb default '[]'::jsonb,        -- メモ [{text, time}, ...]
  history jsonb default '[]'::jsonb,      -- 履歴 [{text, time}, ...]
  settings jsonb default '{}'::jsonb,     -- 設定（AI ON/OFF等）
  updated_at timestamptz default now()
);

-- RLS有効化
alter table user_data enable row level security;

-- 自分のデータのみ読み取り可
create policy "Users can read own data"
  on user_data for select
  using (auth.uid() = user_id);

-- 自分のデータのみ更新可
create policy "Users can update own data"
  on user_data for update
  using (auth.uid() = user_id);

-- 自分のデータのみ挿入可
create policy "Users can insert own data"
  on user_data for insert
  with check (auth.uid() = user_id);

-- 更新時刻自動更新
create or replace function update_user_data_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_data_updated_at on user_data;
create trigger user_data_updated_at
  before update on user_data
  for each row execute function update_user_data_timestamp();
