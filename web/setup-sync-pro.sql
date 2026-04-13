-- Pro key（Stripe顧客ID）ベースの同期テーブル
-- メール/パスワード不要、Pro keyだけで全デバイス同期

create table if not exists pro_data (
  pro_key text primary key,
  dict jsonb default '[]'::jsonb,
  memos jsonb default '[]'::jsonb,
  history jsonb default '[]'::jsonb,
  settings jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- このテーブルはサーバー側からのみアクセス（service key使用）
-- RLSは無効でOK（API側でPro key検証）

create or replace function update_pro_data_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists pro_data_updated_at on pro_data;
create trigger pro_data_updated_at
  before update on pro_data
  for each row execute function update_pro_data_timestamp();
