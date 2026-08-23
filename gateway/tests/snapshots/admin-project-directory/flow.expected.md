# Administrator host directory import

## Browse before import
status=200
scope=filesystem
path=$ROOT/imports
selectable=true
entry=.hidden-reference hidden=true path=$ROOT/imports/.hidden-reference
entry=existing-app hidden=false path=$ROOT/imports/existing-app

## Create project
status=200
name=Existing App
path=$ROOT/imports/existing-app
origin=admin
modelAccessDefaultAllowed=true

## Browse after import
status=200
entry=.hidden-reference hidden=true path=$ROOT/imports/.hidden-reference
