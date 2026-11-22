SELECT json_group_array(json_array(type, name, tbl_name, sql) ORDER BY type, name) AS schema_objects
FROM main.sqlite_schema
WHERE name NOT GLOB 'sqlite_*';
