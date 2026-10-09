# Connor's Wishlist

18th birthday wishlist for family and friends. Static site (GitHub Pages) + Supabase (database, storage, realtime).

- `index.html`, `styles.css`, `app.js` – the whole site, no build step.
- `supabase/migrations/0001_wishlist.sql` – tables, grants, RLS, RPC functions, storage bucket, realtime.
- `tools/dev-server.mjs` – local preview: `node tools/dev-server.mjs` then open http://localhost:5196

## How it works

Guests read the tables directly with the publishable key. Every write (reserve, bought, chip in, admin add/edit/delete)
goes through a Postgres function, so the rules are enforced in the database rather than the browser.

The admin password is not in this repo. It lives in `private.settings` and is set with:

```sql
insert into private.settings (key, value) values ('admin_password', 'NEW-PASSWORD')
on conflict (key) do update set value = excluded.value;
```

Admin: tap the sponsor logo, or open the site with `#admin` on the end to go straight to the password box
without seeing the guest list.
