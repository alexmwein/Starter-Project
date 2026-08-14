-- Held ONLY for the duration of the stabilization loop below. That loop polls
-- the same main group up to 50 times to watch the route settle, and re-deriving
-- it per iteration meant a full tree resolution per poll, which is the bulk of
-- the 45s automation timeouts. The held value is an AX specifier, so every read
-- through it still resolves live values and the loop still observes real change.
-- It is cleared the moment the loop exits, and every decision point afterwards
-- re-resolves from scratch.
property heldMainGroup : missing value

property cachedWorkspaceName : missing value
property cachedWorkspaceGroup : missing value
property cachedWorkspaceRoute : missing value

on clearWorkspaceRouteCache()
	set my cachedWorkspaceName to missing value
	set my cachedWorkspaceGroup to missing value
	set my cachedWorkspaceRoute to missing value
end clearWorkspaceRouteCache

on workspaceMatches(workspaceName, candidateName)
	if candidateName is workspaceName then return true
	if candidateName starts with (workspaceName & " +") then return true
	-- Conductor titles some workspaces with the branch owner prefixed, e.g.
	-- "Owner/name" for a workspace whose relay-side name is just "name". The
	-- slash-anchored comparison keeps this tight: only a full path segment
	-- match counts, so "name" can never match some other "other name".
	if candidateName ends with ("/" & workspaceName) then return true
	if candidateName contains ("/" & workspaceName & " +") then return true
	return false
end workspaceMatches

on draftConflict(existingDraft)
	set encodedDraft to do shell script "/usr/bin/printf %s " & quoted form of existingDraft & " | /usr/bin/base64 | /usr/bin/tr -d '\\n'"
	return "{\"ok\":false,\"code\":\"draft_conflict\",\"draftBase64\":\"" & encodedDraft & "\"}"
end draftConflict

on decodeBase64(encodedValue)
	if encodedValue is "" then return ""
	return do shell script "/usr/bin/printf %s " & quoted form of encodedValue & " | /usr/bin/base64 -D" without altering line endings
end decodeBase64

on normalizedDraft(rawValue)
	set valueText to rawValue as text
	if valueText ends with linefeed then
		if (length of valueText) is 1 then return ""
		return text 1 thru -2 of valueText
	end if
	return valueText
end normalizedDraft

on getWebArea()
	tell application "System Events"
		tell process "Conductor"
			try
				return UI element 1 of scroll area 1 of group 1 of group 1 of front window
			end try
		end tell
	end tell
	return missing value
end getWebArea

on getSidebarGroup()
	return my findSidebarGroup(my workspaceName)
end getSidebarGroup

on isMainGroup(candidate)
	set tabGroupCount to 0
	set composerCount to 0
	tell application "System Events"
		try
			set candidateElements to UI elements of candidate
		on error
			return false
		end try
		-- One Apple Event per attribute for the whole child list instead of two
		-- per child. Every AX read costs the same round trip regardless of what
		-- it returns, so cost here is round-trip count, and this handler runs for
		-- every candidate root on every main-group and sidebar resolution.
		-- Falls back to the per-child reads below on any throw or length
		-- mismatch, so behaviour is identical and merely slower.
		set childCount to count of candidateElements
		set bulkRoles to missing value
		set bulkDescriptions to missing value
		try
			set candidateRoles to role of UI elements of candidate
			set candidateDescriptions to description of UI elements of candidate
			if (count of candidateRoles) is childCount and (count of candidateDescriptions) is childCount then
				set bulkRoles to candidateRoles
				set bulkDescriptions to candidateDescriptions
			end if
		end try
		if bulkRoles is not missing value then
			repeat with bulkIndex from 1 to childCount
				if (item bulkIndex of bulkRoles) is "AXTabGroup" then set tabGroupCount to tabGroupCount + 1
				if (item bulkIndex of bulkDescriptions) is "composer" then set composerCount to composerCount + 1
				if tabGroupCount > 1 or composerCount > 1 then return false
			end repeat
		else
			repeat with childElement in candidateElements
				try
					if (role of childElement as text) is "AXTabGroup" then set tabGroupCount to tabGroupCount + 1
				end try
				try
					if (description of childElement as text) is "composer" then set composerCount to composerCount + 1
				end try
			end repeat
		end if
	end tell
	return tabGroupCount is 1 and composerCount is 1
end isMainGroup

on findSidebarGroup(workspaceName)
	my clearWorkspaceRouteCache()
	set webArea to getWebArea()
	if webArea is missing value then return missing value
	set matchingGroups to {}
	set matchingRoutes to {}
	tell application "System Events"
		try
			set rootElements to UI elements of webArea
		on error
			return missing value
		end try
		repeat with candidate in rootElements
			if my isMainGroup(candidate) is false then
				set workspaceRoute to my getWorkspaceRoute(workspaceName, candidate)
				if workspaceRoute is not missing value then
					copy candidate to end of matchingGroups
					copy workspaceRoute to end of matchingRoutes
				end if
			end if
		end repeat
	end tell
	if (count of matchingGroups) is not 1 then
		my clearWorkspaceRouteCache()
		return missing value
	end if
	set my cachedWorkspaceName to workspaceName
	set my cachedWorkspaceGroup to item 1 of matchingGroups
	set my cachedWorkspaceRoute to item 1 of matchingRoutes
	return item 1 of matchingGroups
end findSidebarGroup

on getMainGroup()
	if my heldMainGroup is not missing value then return my heldMainGroup
	set webArea to getWebArea()
	if webArea is missing value then return missing value
	set matchingGroups to {}
	tell application "System Events"
		try
			set rootElements to UI elements of webArea
		on error
			return missing value
		end try
		repeat with candidate in rootElements
			if my isMainGroup(candidate) then copy candidate to end of matchingGroups
		end repeat
	end tell
	if (count of matchingGroups) is not 1 then return missing value
	return item 1 of matchingGroups
end getMainGroup

-- Bounded deep search for the workspace's sidebar link, used ONLY to escape
-- the 0.81 Dashboard screen. The budget caps total AX reads so a huge
-- Dashboard cannot spin; pressing a link that matches workspaceMatches is
-- exactly what a human click on the sidebar entry does, and everything after
-- it still goes through the full route proof.
on deepPressWorkspaceLink(el, workspaceName, depthLeft, budget)
	if depthLeft is 0 then return false
	set remaining to item 1 of budget
	if remaining is 0 then return false
	set item 1 of budget to remaining - 1
	tell application "System Events"
		try
			if (role of el as text) is "AXLink" then
				if my workspaceMatches(workspaceName, (name of el as text)) then
					perform action "AXPress" of el
					return true
				end if
				return false
			end if
		end try
		try
			set childElements to UI elements of el
		on error
			return false
		end try
	end tell
	repeat with childElement in childElements
		if my deepPressWorkspaceLink(childElement, workspaceName, depthLeft - 1, budget) then return true
	end repeat
	return false
end deepPressWorkspaceLink

on escapeDashboard(workspaceName)
	set webArea to getWebArea()
	if webArea is missing value then return false
	return my deepPressWorkspaceLink(webArea, workspaceName, 14, {400})
end escapeDashboard

-- Conductor renders its dropdowns into the page, not as native menus, so an
-- opened menu appears as a NEW ROOT in the web area whose children are the
-- items. Verified live. Escape closes it. These handlers are used only by the
-- control operations below and never by the send path.
-- Conductor leaves the model and effort buttons with no accessible name; their
-- text lives in descendant AXStaticText. Targeting them by name therefore fails
-- on exactly the two controls this feature exists for, so derive a label from
-- the inner text when the name is empty. Bounded depth and item count so a
-- control with a large subtree cannot spin.
on controlLabelFor(el)
	tell application "System Events"
		try
			if (name of el) is not missing value then
				set directName to name of el as text
				if directName is not "" then return directName
			end if
		end try
	end tell
	set collected to my collectStaticText(el, 4, {12})
	set labelText to ""
	repeat with piece in collected
		set pieceText to piece as text
		if pieceText is not "" then
			if labelText is "" then
				set labelText to pieceText
			else
				set labelText to labelText & " " & pieceText
			end if
		end if
	end repeat
	return labelText
end controlLabelFor

on collectStaticText(el, depthLeft, budget)
	set found to {}
	if depthLeft is 0 then return found
	set remaining to item 1 of budget
	if remaining is 0 then return found
	set item 1 of budget to remaining - 1
	tell application "System Events"
		try
			if (role of el as text) is "AXStaticText" then
				try
					if (value of el) is not missing value then
						set v to value of el as text
						if v is not "" then return {v}
					end if
				end try
				try
					if (name of el) is not missing value then return {name of el as text}
				end try
				return found
			end if
		end try
		try
			set kids to UI elements of el
		on error
			return found
		end try
	end tell
	repeat with kid in kids
		set deeper to my collectStaticText(kid, depthLeft - 1, budget)
		repeat with d in deeper
			copy (d as text) to end of found
		end repeat
	end repeat
	return found
end collectStaticText

on webRootCount()
	set webArea to getWebArea()
	if webArea is missing value then return -1
	tell application "System Events"
		try
			return count of (UI elements of webArea)
		on error
			return -1
		end try
	end tell
end webRootCount

on jsonEscape(rawText)
	set outText to ""
	repeat with charIndex from 1 to (length of rawText)
		set c to character charIndex of rawText
		if c is "\"" then
			set outText to outText & "\\\""
		else if c is "\\" then
			set outText to outText & "\\\\"
		else if (id of c) < 32 then
			set outText to outText & " "
		else
			set outText to outText & c
		end if
	end repeat
	return outText
end jsonEscape

-- Items of any menu roots that appeared at or after beforeCount.
on menuItemsAfter(beforeCount)
	set foundItems to {}
	set webArea to getWebArea()
	if webArea is missing value then return foundItems
	tell application "System Events"
		try
			set rootList to UI elements of webArea
		on error
			return foundItems
		end try
		set rootTotal to count of rootList
		repeat with rootIndex from (beforeCount + 1) to rootTotal
			try
				set menuRoot to item rootIndex of rootList
				set itemRoles to role of UI elements of menuRoot
				set itemNames to name of UI elements of menuRoot
				repeat with itemIndex from 1 to (count of itemRoles)
					set itemRole to item itemIndex of itemRoles
					if itemRole is "AXButton" or itemRole is "AXRadioButton" or itemRole is "AXMenuItem" or itemRole is "AXCheckBox" then
						set itemName to item itemIndex of itemNames
						if itemName is not missing value then copy (itemName as text) to end of foundItems
					end if
				end repeat
			end try
		end repeat
	end tell
	return foundItems
end menuItemsAfter

on closeAnyMenu()
	tell application "System Events"
		try
			key code 53
		end try
	end tell
	delay 0.35
end closeAnyMenu

-- Presses an item by exact name in any menu root that opened at or after
-- beforeCount. Exact match only: a prefix match could select "Opus" when the
-- caller asked for a different entry that merely starts the same way.
on pressMenuItemNamed(beforeCount, wantedName)
	set webArea to getWebArea()
	if webArea is missing value then return false
	tell application "System Events"
		try
			set rootList to UI elements of webArea
		on error
			return false
		end try
		set rootTotal to count of rootList
		repeat with rootIndex from (beforeCount + 1) to rootTotal
			try
				set menuRoot to item rootIndex of rootList
				repeat with candidate in (UI elements of menuRoot)
					try
						if (name of candidate as text) is wantedName then
							perform action "AXPress" of candidate
							return true
						end if
					end try
				end repeat
			end try
		end repeat
	end tell
	return false
end pressMenuItemNamed

on composerControls()
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return {}
	tell application "System Events"
		try
			set mainElements to UI elements of mainGroup
			repeat with candidate in mainElements
				if (description of candidate as text) is "composer" then
					return UI elements of candidate
				end if
			end repeat
		end try
	end tell
	return {}
end composerControls

on getWorkspaceRoute(workspaceName, sidebarGroup)
	if sidebarGroup is missing value then return missing value
	set cachedName to my cachedWorkspaceName
	set cachedGroup to my cachedWorkspaceGroup
	set cachedRoute to my cachedWorkspaceRoute
	if cachedName is not missing value and cachedGroup is not missing value and cachedRoute is not missing value then
		if workspaceName is cachedName and sidebarGroup is cachedGroup then
			my clearWorkspaceRouteCache()
			return cachedRoute
		end if
		my clearWorkspaceRouteCache()
	end if
	set matchingRoutes to {}
	set selectedWorkspaceCount to 0
	tell application "System Events"
		try
			set sidebarElements to UI elements of sidebarGroup
		on error
			return missing value
		end try
		set sidebarChildCount to count of sidebarElements
		repeat with containerIndex from 1 to sidebarChildCount
			set workspaceContainer to item containerIndex of sidebarElements
			try
				set workspaceElements to UI elements of workspaceContainer
				set containerChildCount to count of workspaceElements
				repeat with linkIndex from 1 to containerChildCount
					set candidate to item linkIndex of workspaceElements
					if (role of candidate as text) is "AXLink" then
						set candidateClasses to value of attribute "AXDOMClassList" of candidate
						if candidateClasses contains "bg-sidebar-accent" then set selectedWorkspaceCount to selectedWorkspaceCount + 1
						set candidateName to name of candidate as text
						if my workspaceMatches(workspaceName, candidateName) then
							set containerOffset to containerIndex - 1
							set linkOffset to linkIndex - 1
							copy {candidate, containerOffset, linkOffset, sidebarChildCount, containerChildCount} to end of matchingRoutes
						end if
					end if
				end repeat
			on error
				return missing value
			end try
		end repeat
	end tell
	if (count of matchingRoutes) is not 1 or selectedWorkspaceCount is not 1 then return missing value
	return item 1 of matchingRoutes
end getWorkspaceRoute

on getSessionTabs()
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return {}
	tell application "System Events"
		try
			set mainElements to UI elements of mainGroup
			repeat with candidate in mainElements
				try
					if (role of candidate as text) is "AXTabGroup" then
						set tabGroupChildren to UI elements of candidate
						set sessionTabs to {}
						repeat with tabGroupChild in tabGroupChildren
							try
								if (role of tabGroupChild as text) is "AXRadioButton" then
									copy tabGroupChild to end of sessionTabs
								else
									set tabGroupElements to UI elements of tabGroupChild
									repeat with tabGroupElement in tabGroupElements
										try
											if (role of tabGroupElement as text) is "AXRadioButton" then copy tabGroupElement to end of sessionTabs
										end try
									end repeat
								end if
							end try
						end repeat
						return sessionTabs
					end if
				end try
			end repeat
		end try
	end tell
	return {}
end getSessionTabs

on getComposerGroup()
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return missing value
	tell application "System Events"
		set mainElements to UI elements of mainGroup
		repeat with candidate in mainElements
			try
				if (description of candidate as text) is "composer" then return candidate
			end try
		end repeat
	end tell
	return missing value
end getComposerGroup

on getTextAreaFromComposer(composerGroup)
	if composerGroup is missing value then return missing value
	tell application "System Events"
		try
			set composerElements to UI elements of composerGroup
			repeat with candidate in composerElements
				try
					if (role of candidate as text) is "AXTextArea" then return candidate
				end try
			end repeat
		end try
	end tell
	return missing value
end getTextAreaFromComposer

on getTextArea()
	return my getTextAreaFromComposer(getComposerGroup())
end getTextArea

on workspaceLinkIsSelected(workspaceLink, workspaceName)
	if workspaceLink is missing value then return false
	tell application "System Events"
		try
			if (role of workspaceLink as text) is not "AXLink" then return false
			set candidateName to name of workspaceLink as text
			if my workspaceMatches(workspaceName, candidateName) is false then return false
			set candidateClasses to value of attribute "AXDOMClassList" of workspaceLink
			return candidateClasses contains "bg-sidebar-accent"
		end try
	end tell
	return false
end workspaceLinkIsSelected

on sessionIsSelected(sessionTitle, sessionOrdinal)
	tell application "System Events"
		set matchedCount to 0
		repeat with candidate in my getSessionTabs()
			try
				if (name of candidate as text) is ("Close chat " & sessionTitle) then
					set matchedCount to matchedCount + 1
					if matchedCount is sessionOrdinal then return value of candidate as boolean
				end if
			end try
		end repeat
	end tell
	return false
end sessionIsSelected

on commitAndPressMessage(textArea, inputScriptPath, pressMarkerPath, conductorPid, workspaceContainerIndex, workspaceLinkIndex, sidebarChildCount, containerChildCount)
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		set focused of textArea to true
	end tell
	delay 0.05
	set routeEnvironment to "POCKET_WORKSPACE_CONTAINER_INDEX=" & (workspaceContainerIndex as text) & " POCKET_WORKSPACE_LINK_INDEX=" & (workspaceLinkIndex as text) & " POCKET_WORKSPACE_SIDEBAR_CHILD_COUNT=" & (sidebarChildCount as text) & " POCKET_WORKSPACE_CONTAINER_CHILD_COUNT=" & (containerChildCount as text)
	try
		set helperResult to do shell script "/usr/bin/env " & routeEnvironment & " POCKET_PRESS_MARKER_PATH=" & quoted form of pressMarkerPath & " POCKET_OPERATION=type-and-send /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		if errorText contains "draft_conflict" then return "draft_conflict"
		if errorText contains "session_locked" then return "session_locked"
		-- The helper throws typed codes; passing them through names exactly
		-- which AX assumption broke instead of collapsing every distinct
		-- failure into automation_failed. The list mirrors the codes the
		-- helper actually throws; anything unrecognized still falls through.
		-- deadline_exceeded is the helper bounding its own lifetime so the
		-- transport kill can never orphan it mid-send.
		repeat with knownCode in {"send_unavailable", "user_input_active", "route_changed", "composer_focus_changed", "draft_changed", "composer_update_failed", "invalid_encoding", "unicode_roundtrip_failed", "target_not_active", "deadline_exceeded"}
			if errorText contains knownCode then return "code:" & knownCode
		end repeat
		return "automation_failed"
	end try
	if helperResult starts with "pressed:" then return helperResult
	if helperResult starts with "ambiguous:" then return helperResult
	if helperResult starts with "interrupted:" then return helperResult
	if helperResult starts with "retryable:" then return helperResult
	if helperResult is "session_locked" then return helperResult
	return "automation_failed"
end commitAndPressMessage

on waitForInputIdle(inputScriptPath, conductorPid)
	try
		set helperResult to do shell script "/usr/bin/env POCKET_OPERATION=input-check /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		if errorText contains "session_locked" then return "session_locked"
		return "input_helper_unavailable"
	end try
	if helperResult is "ready" then return "ready"
	if helperResult is "busy" then return "busy"
	return "input_helper_unavailable"
end waitForInputIdle

set operationMode to system attribute "POCKET_OPERATION"
set inputScriptPath to system attribute "POCKET_INPUT_SCRIPT"
set pressMarkerPath to system attribute "POCKET_PRESS_MARKER_PATH"

tell application "System Events"
	if UI elements enabled is false then return "{\"ok\":false,\"code\":\"accessibility_disabled\"}"
	if not (exists process "Conductor") then return "{\"ok\":false,\"code\":\"conductor_not_running\"}"
	tell process "Conductor"
		if not (exists front window) then return "{\"ok\":false,\"code\":\"conductor_window_unavailable\"}"
		set conductorPid to unix id
	end tell
end tell

if operationMode is "doctor" then
	set textArea to getTextArea()
	if textArea is missing value then
		return "{\"ok\":false,\"code\":\"composer_unavailable\"}"
	end if
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		set focused of textArea to true
	end tell
	try
		set helperResult to do shell script "/usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		if errorText contains "session_locked" then return "{\"ok\":false,\"code\":\"session_locked\"}"
		return "{\"ok\":false,\"code\":\"input_helper_unavailable\"}"
	end try
	if helperResult is not "ready" then return "{\"ok\":false,\"code\":\"input_helper_unavailable\"}"
	return "{\"ok\":true,\"code\":\"ready\"}"
end if

set workspaceName to my decodeBase64(system attribute "POCKET_WORKSPACE_NAME_BASE64")
set sessionTitle to my decodeBase64(system attribute "POCKET_SESSION_TITLE_BASE64")
set sessionOrdinal to (system attribute "POCKET_SESSION_ORDINAL") as integer
set messageText to my decodeBase64(system attribute "POCKET_MESSAGE_BASE64")
set replaceDraft to (system attribute "POCKET_REPLACE_DRAFT") is "true"
set expectedDraft to my decodeBase64(system attribute "POCKET_EXPECTED_DRAFT_BASE64")
set retryInputCounters to system attribute "POCKET_EXPECTED_INPUT_COUNTERS"

set inputReadiness to my waitForInputIdle(inputScriptPath, conductorPid)
if inputReadiness is "busy" then return "{\"ok\":false,\"code\":\"user_input_active\"}"
if inputReadiness is "session_locked" then return "{\"ok\":false,\"code\":\"session_locked\"}"
if inputReadiness is not "ready" then return "{\"ok\":false,\"code\":\"input_helper_unavailable\"}"

-- Conductor 0.81 introduced a Dashboard/Home screen and lands on it after an
-- update restart. On that screen no main group (tab strip + composer) exists,
-- so every send strands with nobody at the Mac to click a workspace. The
-- workspace links are still in the sidebar, just nested deeper than the
-- two-level route scan reads. When and only when the main group is absent,
-- deep-search for the workspace link, press it, and wait for the session view.
-- This runs after the input-idle and lock gates and before any route
-- resolution, so the readiness-before-route ordering is unchanged, and a
-- genuine absence still fails with the same codes it always did.
if getMainGroup() is missing value then
	set escaped to my escapeDashboard(workspaceName)
	if escaped then
		repeat with waitIndex from 1 to 40
			if getMainGroup() is not missing value then exit repeat
			delay 0.25
		end repeat
	end if
end if

set sidebarGroup to getSidebarGroup()
if sidebarGroup is missing value then return "{\"ok\":false,\"code\":\"workspace_list_unavailable\"}"
set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)
if workspaceRoute is missing value then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
set workspaceLink to item 1 of workspaceRoute
set workspaceContainerIndex to item 2 of workspaceRoute
set workspaceLinkIndex to item 3 of workspaceRoute
set sidebarChildCount to item 4 of workspaceRoute
set containerChildCount to item 5 of workspaceRoute
tell application "System Events"
	set workspaceClasses to value of attribute "AXDOMClassList" of workspaceLink
	set routeAlreadySelected to false
	if workspaceClasses contains "bg-sidebar-accent" then
		set routeAlreadySelected to my sessionIsSelected(sessionTitle, sessionOrdinal)
	else
		if retryInputCounters is "" then perform action "AXPress" of workspaceLink
	end if
end tell

if retryInputCounters is not "" and routeAlreadySelected is false then return "{\"ok\":false,\"code\":\"user_input_active\"}"

set sessionFound to routeAlreadySelected
if sessionFound is false then
	repeat with waitIndex from 1 to 50
		delay 0.1
		tell application "System Events"
			set matchedCount to 0
			set sessionTabs to my getSessionTabs()
			repeat with candidate in sessionTabs
				try
					set candidateName to name of candidate as text
					if candidateName is ("Close chat " & sessionTitle) then
						set matchedCount to matchedCount + 1
						if matchedCount is sessionOrdinal then
							if (value of candidate as boolean) is false then perform action "AXPress" of candidate
							set sessionFound to true
							exit repeat
						end if
					end if
				end try
			end repeat
		end tell
		if sessionFound then exit repeat
	end repeat
end if

if sessionFound is false then return "{\"ok\":false,\"code\":\"session_not_visible\"}"

if routeAlreadySelected is false then
	set sidebarGroup to getSidebarGroup()
	if sidebarGroup is missing value then return "{\"ok\":false,\"code\":\"workspace_list_unavailable\"}"
	set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)
	if workspaceRoute is missing value then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
	set workspaceLink to item 1 of workspaceRoute
	set workspaceContainerIndex to item 2 of workspaceRoute
	set workspaceLinkIndex to item 3 of workspaceRoute
	set sidebarChildCount to item 4 of workspaceRoute
	set containerChildCount to item 5 of workspaceRoute
end if

set stableRouteChecks to 0
set my heldMainGroup to getMainGroup()
repeat with waitIndex from 1 to 50
	delay 0.1
	if my workspaceLinkIsSelected(workspaceLink, workspaceName) and my sessionIsSelected(sessionTitle, sessionOrdinal) then
		set stableRouteChecks to stableRouteChecks + 1
		if stableRouteChecks is 3 then exit repeat
	else
		set stableRouteChecks to 0
	end if
end repeat
set my heldMainGroup to missing value
if stableRouteChecks is not 3 then return "{\"ok\":false,\"code\":\"session_not_visible\"}"

-- Control operations run HERE, after the route is proven and before any
-- send-specific logic, so they act on exactly the workspace and session the
-- caller named. Each returns immediately; the send path below is untouched.
if operationMode is "list-controls" then
	set controlList to my composerControls()
	set jsonItems to ""
	tell application "System Events"
		repeat with candidate in controlList
			try
				set candidateRole to role of candidate as text
				if candidateRole is not "AXTextArea" then
					set candidateName to my controlLabelFor(candidate)
					set candidateValue to ""
					try
						if (value of candidate) is not missing value then set candidateValue to (value of candidate as text)
					end try
					if jsonItems is not "" then set jsonItems to jsonItems & ","
					set jsonItems to jsonItems & "{\"role\":\"" & my jsonEscape(candidateRole) & "\",\"label\":\"" & my jsonEscape(candidateName) & "\",\"value\":\"" & my jsonEscape(candidateValue) & "\"}"
				end if
			end try
		end repeat
	end tell
	return "{\"ok\":true,\"code\":\"controls\",\"controls\":[" & jsonItems & "]}"
end if

if operationMode is "menu-open" or operationMode is "menu-choose" then
	set controlLabel to my decodeBase64(system attribute "POCKET_CONTROL_LABEL_BASE64")
	set itemLabel to my decodeBase64(system attribute "POCKET_MENU_ITEM_BASE64")
	set controlList to my composerControls()
	set targetControl to missing value
	-- Model and effort are icon-only buttons with no accessible name and no
	-- inner text, so a label cannot address them. Accept "#N" to target the
	-- Nth control from list-controls, which is what the phone shows. Label
	-- matching still runs first so the named controls stay stable across
	-- reorders, and the index path is exact: it never falls back to a guess.
	if controlLabel starts with "#" then
		try
			set wantedIndex to (text 2 thru -1 of controlLabel) as integer
			if wantedIndex >= 0 and wantedIndex < (count of controlList) then
				set targetControl to item (wantedIndex + 1) of controlList
			end if
		end try
		if targetControl is missing value then return "{\"ok\":false,\"code\":\"control_not_found\"}"
	else
		tell application "System Events"
			repeat with candidate in controlList
				try
					if my controlLabelFor(candidate) is controlLabel then
						set targetControl to candidate
						exit repeat
					end if
				end try
			end repeat
		end tell
	end if
	if targetControl is missing value then return "{\"ok\":false,\"code\":\"control_not_found\"}"
	-- A checkbox has no menu; pressing it IS the toggle.
	set targetRole to ""
	tell application "System Events"
		try
			set targetRole to role of targetControl as text
		end try
	end tell
	if targetRole is "AXCheckBox" then
		if operationMode is "menu-open" then return "{\"ok\":true,\"code\":\"menu\",\"toggle\":true,\"items\":[]}"
		tell application "System Events"
			try
				perform action "AXPress" of targetControl
			on error
				return "{\"ok\":false,\"code\":\"control_press_failed\"}"
			end try
		end tell
		return "{\"ok\":true,\"code\":\"toggled\"}"
	end if
	set rootsBefore to my webRootCount()
	if rootsBefore is -1 then return "{\"ok\":false,\"code\":\"conductor_window_unavailable\"}"
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		try
			perform action "AXPress" of targetControl
		on error
			return "{\"ok\":false,\"code\":\"control_press_failed\"}"
		end try
	end tell
	delay 0.9
	if operationMode is "menu-open" then
		set foundItems to my menuItemsAfter(rootsBefore)
		my closeAnyMenu()
		set jsonItems to ""
		repeat with anItem in foundItems
			if jsonItems is not "" then set jsonItems to jsonItems & ","
			set jsonItems to jsonItems & "\"" & my jsonEscape(anItem as text) & "\""
		end repeat
		return "{\"ok\":true,\"code\":\"menu\",\"items\":[" & jsonItems & "]}"
	end if
	if itemLabel is "" then
		my closeAnyMenu()
		return "{\"ok\":false,\"code\":\"menu_item_required\"}"
	end if
	set didPress to my pressMenuItemNamed(rootsBefore, itemLabel)
	-- Always leave no menu open, whether or not the item was found.
	my closeAnyMenu()
	if didPress is false then return "{\"ok\":false,\"code\":\"menu_item_not_found\"}"
	return "{\"ok\":true,\"code\":\"chosen\"}"
end if

if operationMode is "tab-new" then
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return "{\"ok\":false,\"code\":\"composer_unavailable\"}"
	set tabTrailing to missing value
	tell application "System Events"
		try
			repeat with candidate in (UI elements of mainGroup)
				if (role of candidate as text) is "AXTabGroup" then
					set tabChildren to UI elements of candidate
					set trailing to item (count of tabChildren) of tabChildren
					if (role of trailing as text) is not "AXRadioButton" then set tabTrailing to trailing
					exit repeat
				end if
			end repeat
		end try
	end tell
	if tabTrailing is missing value then return "{\"ok\":false,\"code\":\"new_tab_control_unavailable\"}"
	set rootsBefore to my webRootCount()
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		try
			perform action "AXPress" of tabTrailing
		on error
			return "{\"ok\":false,\"code\":\"control_press_failed\"}"
		end try
	end tell
	delay 0.9
	set foundItems to my menuItemsAfter(rootsBefore)
	if (count of foundItems) is 0 then return "{\"ok\":true,\"code\":\"tab_created\"}"
	set jsonItems to ""
	repeat with anItem in foundItems
		if jsonItems is not "" then set jsonItems to jsonItems & ","
		set jsonItems to jsonItems & "\"" & my jsonEscape(anItem as text) & "\""
	end repeat
	my closeAnyMenu()
	return "{\"ok\":true,\"code\":\"tab_menu\",\"items\":[" & jsonItems & "]}"
end if

if operationMode is "tab-close" then
	-- Destructive and irreversible. Only ever closes the tab whose accessible
	-- name matches the caller's session EXACTLY, and refuses if the caller did
	-- not pass the explicit confirmation token, so a stray request can never
	-- delete a conversation.
	if (system attribute "POCKET_CONFIRM_CLOSE") is not "yes" then
		return "{\"ok\":false,\"code\":\"close_not_confirmed\"}"
	end if
	set wantedTabName to "Close chat " & sessionTitle
	set matchedCount to 0
	set targetTab to missing value
	repeat with candidate in my getSessionTabs()
		try
			if (name of candidate as text) is wantedTabName then
				set matchedCount to matchedCount + 1
				if matchedCount is sessionOrdinal then set targetTab to candidate
			end if
		end try
	end repeat
	if targetTab is missing value then return "{\"ok\":false,\"code\":\"session_not_visible\"}"
	set rootsBefore to my webRootCount()
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		try
			perform action "AXShowMenu" of targetTab
		on error
			return "{\"ok\":false,\"code\":\"control_press_failed\"}"
		end try
	end tell
	delay 0.9
	set foundItems to my menuItemsAfter(rootsBefore)
	set jsonItems to ""
	repeat with anItem in foundItems
		if jsonItems is not "" then set jsonItems to jsonItems & ","
		set jsonItems to jsonItems & "\"" & my jsonEscape(anItem as text) & "\""
	end repeat
	my closeAnyMenu()
	return "{\"ok\":true,\"code\":\"tab_menu\",\"items\":[" & jsonItems & "]}"
end if

set textArea to missing value
repeat with waitIndex from 1 to 50
	set textArea to getTextArea()
	if textArea is not missing value then exit repeat
	delay 0.1
end repeat
if textArea is missing value then return "{\"ok\":false,\"code\":\"composer_unavailable\"}"

tell application "System Events"
	set existingDraft to my normalizedDraft(value of textArea as text)
	considering case
		if existingDraft is not messageText then
			if replaceDraft is false and existingDraft is not "" then return my draftConflict(existingDraft)
			if replaceDraft is true and existingDraft is not expectedDraft then return my draftConflict(existingDraft)
		end if
	end considering
end tell

if my workspaceLinkIsSelected(workspaceLink, workspaceName) is false then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
if my sessionIsSelected(sessionTitle, sessionOrdinal) is false then return "{\"ok\":false,\"code\":\"session_not_visible\"}"

set commitResult to my commitAndPressMessage(textArea, inputScriptPath, pressMarkerPath, conductorPid, workspaceContainerIndex, workspaceLinkIndex, sidebarChildCount, containerChildCount)
if commitResult is "draft_conflict" then
	set latestTextArea to getTextArea()
	if latestTextArea is missing value then return "{\"ok\":false,\"code\":\"composer_unavailable\"}"
	tell application "System Events"
		set latestDraft to my normalizedDraft(value of latestTextArea as text)
	end tell
	return my draftConflict(latestDraft)
end if
if commitResult starts with "pressed:" then
	set pressedAt to text 9 thru -1 of commitResult
	return "{\"ok\":true,\"code\":\"sent\",\"pressedAt\":" & pressedAt & ",\"composerOwned\":true}"
else if commitResult starts with "ambiguous:" then
	set pressedAt to text 11 thru -1 of commitResult
	return "{\"ok\":false,\"code\":\"send_not_confirmed\",\"pressedAt\":" & pressedAt & ",\"composerOwned\":true}"
else if commitResult starts with "interrupted:" then
	set pressedAt to text 13 thru -1 of commitResult
	return "{\"ok\":false,\"code\":\"send_interrupted\",\"pressedAt\":" & pressedAt & ",\"composerOwned\":false}"
else if commitResult starts with "retryable:" then
	set retryCertificate to text 11 thru -1 of commitResult
	return "{\"ok\":false,\"code\":\"composer_changed_pre_send\",\"retryCertificate\":\"" & retryCertificate & "\"}"
else if commitResult is "session_locked" then
	return "{\"ok\":false,\"code\":\"session_locked\"}"
else if commitResult starts with "code:" then
	return "{\"ok\":false,\"code\":\"" & (text 6 thru -1 of commitResult) & "\"}"
else
	return "{\"ok\":false,\"code\":\"automation_failed\"}"
end if
