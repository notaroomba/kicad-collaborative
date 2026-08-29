-- Gallery polish: a short human description on each project.
ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
