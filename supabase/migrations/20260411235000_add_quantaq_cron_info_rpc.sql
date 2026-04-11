-- Expose the live cron schedule and last-run time to the browser so the
-- dashboard can show real values from cron.* instead of hardcoded guesses.
-- cron.* tables are not readable by authenticated/anon roles by default,
-- so this SECURITY DEFINER function wraps them with a narrow interface.

create or replace function public.get_quantaq_cron_info()
returns table (
  jobname text,
  schedule text,
  last_run_at timestamptz,
  last_run_status text,
  last_run_message text
)
language sql
security definer
set search_path = public, cron
as $$
  select
    j.jobname::text,
    j.schedule::text,
    d.start_time,
    d.status::text,
    d.return_message::text
  from cron.job j
  left join lateral (
    select start_time, status, return_message
    from cron.job_run_details
    where jobid = j.jobid
    order by start_time desc
    limit 1
  ) d on true
  where j.jobname like 'quantaq%'
  order by j.jobid
  limit 1;
$$;

grant execute on function public.get_quantaq_cron_info() to authenticated;
grant execute on function public.get_quantaq_cron_info() to anon;
