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
property targetRepositoryName : ""
property workspaceHintContainerIndex : ""
property workspaceHintLinkIndex : ""
property workspaceHintSidebarChildCount : ""
property workspaceHintContainerChildCount : ""
property routeDeadline : missing value
property routeDeadlineAt : ""
property routeBudgetDidExpire : false

on routeBudgetExpired()
	if my routeDeadline is missing value then return false
	if (current date) is greater than or equal to my routeDeadline then
		set my routeBudgetDidExpire to true
		return true
	end if
	return false
end routeBudgetExpired

on routeBudgetFailure()
	return "{\"ok\":false,\"code\":\"automation_budget_exhausted\"}"
end routeBudgetFailure

on clearWorkspaceRouteCache()
	set my cachedWorkspaceName to missing value
	set my cachedWorkspaceGroup to missing value
	set my cachedWorkspaceRoute to missing value
end clearWorkspaceRouteCache

-- Conductor appends a live diff badge to a workspace label: "name +8",
-- "name +3.7k -165", and, for a workspace whose changes are only deletions,
-- "name -165" with no plus at all. Matching only the plus form left that last
-- shape unroutable, which is a total send outage for that workspace that no
-- retry can clear. Both signs are anchored on a leading space, so the
-- boundary stays tight and "name" still cannot match "name two".
on hasDiffBadge(baseName, candidateName)
	if candidateName starts with (baseName & " +") then return true
	if candidateName starts with (baseName & " -") then return true
	return false
end hasDiffBadge

-- "front window" is false whenever Conductor is hidden, minimized, or has had
-- its last window closed. All three are ordinary states the operator leaves the
-- Mac in, and all three are recoverable, but the send used to fail immediately
-- with conductor_window_unavailable. That failure is classified retry-safe, so
-- the phone offered Retry, and the retry asked the same hidden window again and
-- failed again in under a second. Observed 2026-08-17: four such failures, each
-- under 1.2s, each clearing only once a window happened to come back.
--
-- Electron recreates its main window on activate when none is open, so
-- activating is usually enough. Returns true when a usable window exists.
on restoreConductorWindow()
	try
		tell application "Conductor" to activate
	end try
	-- Six seconds, not one. The window is also missing for a moment while the
	-- Mac is waking and while Conductor is relaunching, which is exactly when a
	-- phone send arrives: the operator wakes the Mac and sends. Failing in under
	-- a second there is what made this look like a broken Retry. Six seconds is
	-- well inside the 45s automation budget.
	set recoveryDeadline to (current date) + 6
	repeat while (current date) < recoveryDeadline
		delay 0.2
		tell application "System Events"
			tell process "Conductor"
				if exists window 1 then
					try
						if (value of attribute "AXMinimized" of window 1) is true then
							set value of attribute "AXMinimized" of window 1 to false
						end if
					end try
					if exists front window then return true
				end if
			end tell
		end tell
	end repeat
	return false
end restoreConductorWindow

on workspaceMatches(workspaceName, candidateName)
	if candidateName is workspaceName then return true
	if my hasDiffBadge(workspaceName, candidateName) then return true
	-- Conductor titles some workspaces with the branch owner prefixed, e.g.
	-- "Owner/name" for a workspace whose relay-side name is just "name". The
	-- slash-anchored comparison keeps this tight: only a full path segment
	-- match counts, so "name" can never match some other "other name".
	if candidateName ends with ("/" & workspaceName) then return true
	if candidateName contains ("/" & workspaceName & " +") then return true
	if candidateName contains ("/" & workspaceName & " -") then return true
	return false
end workspaceMatches

on repositoryHeaderMatches(repositoryName, candidateName)
	if repositoryName is "" then return true
	set headerSuffix to " Repo settings New workspace"
	if candidateName does not end with headerSuffix then return false
	set labelLength to (length of candidateName) - (length of headerSuffix)
	if labelLength < 1 then return false
	set repositoryLabel to text 1 thru labelLength of candidateName
	if repositoryLabel is repositoryName then return true
	if repositoryLabel is (repositoryName & " " & repositoryName) then return true
	if repositoryLabel is ("💀 " & repositoryName) then return true
	return false
end repositoryHeaderMatches

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
	return my findSidebarGroupWithRetry(my workspaceName)
end getSidebarGroup

-- A collapsed project removes all of its workspace AXLinks, which makes the
-- exactly-one sidebar proof correctly return zero. Diagnose that real shape in
-- the fixture-tested JXA reader, but never press the project row here: in 0.82.6
-- AXPress opens repo Settings rather than expanding it. Any unreadable or
-- malformed diagnosis falls back to the old generic failure.
on workspaceListFailure(inputScriptPath, conductorPid)
	try
		return do shell script "/usr/bin/env POCKET_OPERATION=workspace-failure /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error
		return "{\"ok\":false,\"code\":\"workspace_list_unavailable\"}"
	end try
end workspaceListFailure

on expandCollapsedProject(inputScriptPath, conductorPid)
	set my projectExpansionAttempted to true
	try
		return do shell script "/usr/bin/env POCKET_OPERATION=workspace-expand /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error
		return "not-expanded"
	end try
end expandCollapsedProject

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
				if my routeBudgetExpired() then return false
				if (item bulkIndex of bulkRoles) is "AXTabGroup" then set tabGroupCount to tabGroupCount + 1
				if (item bulkIndex of bulkDescriptions) is "composer" then set composerCount to composerCount + 1
				if tabGroupCount > 1 or composerCount > 1 then return false
			end repeat
		else
			repeat with childElement in candidateElements
				if my routeBudgetExpired() then return false
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

on mainGroupCandidates(rootElements)
	set matchingGroups to {}
	set inspectedCount to count of rootElements
	if inspectedCount > my maxMainRootCandidates then return {}
	tell application "System Events"
		repeat with candidate in rootElements
			if my isMainGroup(candidate) then
				copy candidate to end of matchingGroups
			else
				try
					set candidateElements to UI elements of candidate
				on error
					set candidateElements to {}
				end try
				set childCount to count of candidateElements
				if childCount > 0 then
					set bulkRoles to missing value
					try
						set candidateRoles to role of UI elements of candidate
						if (count of candidateRoles) is childCount then set bulkRoles to candidateRoles
					end try
					repeat with childIndex from 1 to childCount
						set childRole to ""
						if bulkRoles is not missing value then
							set childRole to item childIndex of bulkRoles
						else
							try
								set childRole to role of item childIndex of candidateElements as text
							end try
						end if
						if childRole is "AXGroup" then
							set inspectedCount to inspectedCount + 1
							if inspectedCount > my maxMainRootCandidates then return {}
							set nestedCandidate to item childIndex of candidateElements
							if my isMainGroup(nestedCandidate) then copy nestedCandidate to end of matchingGroups
						end if
					end repeat
				end if
			end if
		end repeat
	end tell
	return matchingGroups
end mainGroupCandidates

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
			if my routeBudgetExpired() then return missing value
			if my heldMainGroup is not missing value and candidate is my heldMainGroup then
				(* The unique main group was already resolved for this navigation phase. *)
			else if my isMainGroup(candidate) is false then
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

-- Conductor rebuilds the Electron accessibility tree while chats and projects
-- update. One read can therefore see no unique sidebar even though the next
-- read is healthy. This wrapper retries only that read-only scan. It never
-- presses a route or changes the Mac, and the full route proof still runs
-- after it returns.
on findSidebarGroupWithRetry(workspaceName)
	repeat with attemptIndex from 1 to 3
		if my routeBudgetExpired() then return missing value
		set sidebarGroup to my findSidebarGroup(workspaceName)
		if sidebarGroup is not missing value then return sidebarGroup
		if attemptIndex is less than 3 then delay 0.15
	end repeat
	return missing value
end findSidebarGroupWithRetry

on getMainGroup()
	if my heldMainGroup is not missing value then return my heldMainGroup
	set webArea to getWebArea()
	if webArea is missing value then return missing value
	tell application "System Events"
		try
			set rootElements to UI elements of webArea
		on error
			return missing value
		end try
		repeat with candidate in rootElements
			if my routeBudgetExpired() then return missing value
			if my isMainGroup(candidate) then copy candidate to end of matchingGroups
		end repeat
	end tell
	set matchingGroups to my mainGroupCandidates(rootElements)
	if (count of matchingGroups) is not 1 then return missing value
	set my heldMainGroup to item 1 of matchingGroups
	return my heldMainGroup
end getMainGroup

-- Bounded deep search for the workspace's sidebar link, used ONLY to escape
-- the 0.81 Dashboard screen. The budget caps total AX reads so a huge
-- Dashboard cannot spin; pressing a link that matches workspaceMatches is
-- exactly what a human click on the sidebar entry does, and everything after
-- it still goes through the full route proof.
on deepPressWorkspaceLink(el, workspaceName, depthLeft, budget)
	if my routeBudgetExpired() then return false
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

on inspectWorkspaceCandidate(workspaceName, candidate, candidateRole, candidateName, candidateClasses, repositoryMatches, containerIndex, linkIndex, sidebarChildCount, containerChildCount)
	if candidateRole is not "AXLink" then return {0, missing value}
	set selectedIncrement to 0
	if candidateClasses contains "bg-sidebar-accent" then set selectedIncrement to 1
	if repositoryMatches is false then return {selectedIncrement, missing value}
	if my workspaceMatches(workspaceName, candidateName) is false then return {selectedIncrement, missing value}
	set containerOffset to containerIndex - 1
	set linkOffset to linkIndex - 1
	return {selectedIncrement, {candidate, containerOffset, linkOffset, sidebarChildCount, containerChildCount}}
end inspectWorkspaceCandidate

on workspaceLinkBelongsToRepository(workspaceElements, linkIndex, repositoryName)
	if repositoryName is "" then return true
	if linkIndex <= 1 then return false
	repeat with reverseOffset from 1 to (linkIndex - 1)
		set headerIndex to linkIndex - reverseOffset
		set candidate to item headerIndex of workspaceElements
		tell application "System Events"
			try
				if (role of candidate as text) is "AXButton" then
					set candidateName to name of candidate as text
					if candidateName ends with " Repo settings New workspace" then return my repositoryHeaderMatches(repositoryName, candidateName)
				end if
			end try
		end tell
	end repeat
	return false
end workspaceLinkBelongsToRepository

on getWorkspaceRouteFromHint(workspaceName, sidebarGroup)
	if my workspaceHintContainerIndex is "" or my workspaceHintLinkIndex is "" or my workspaceHintSidebarChildCount is "" or my workspaceHintContainerChildCount is "" then return missing value
	if my routeBudgetExpired() then return missing value
	try
		set containerIndex to (my workspaceHintContainerIndex as integer) + 1
		set linkIndex to (my workspaceHintLinkIndex as integer) + 1
		set expectedSidebarChildCount to my workspaceHintSidebarChildCount as integer
		set expectedContainerChildCount to my workspaceHintContainerChildCount as integer
		if containerIndex < 1 or linkIndex < 1 then return missing value
		tell application "System Events"
			set sidebarElements to UI elements of sidebarGroup
			if (count of sidebarElements) is not expectedSidebarChildCount then return missing value
			if containerIndex > (count of sidebarElements) then return missing value
			set workspaceContainer to item containerIndex of sidebarElements
			set workspaceElements to UI elements of workspaceContainer
			if (count of workspaceElements) is not expectedContainerChildCount then return missing value
			if linkIndex > (count of workspaceElements) then return missing value
			set candidate to item linkIndex of workspaceElements
			if (role of candidate as text) is not "AXLink" then return missing value
			if my workspaceMatches(workspaceName, (name of candidate as text)) is false then return missing value
			if my workspaceLinkBelongsToRepository(workspaceElements, linkIndex, my targetRepositoryName) is false then return missing value
			set candidateClasses to value of attribute "AXDOMClassList" of candidate
			if candidateClasses does not contain "bg-sidebar-accent" then return missing value
		end tell
		return {candidate, containerIndex - 1, linkIndex - 1, expectedSidebarChildCount, expectedContainerChildCount}
	on error
		return missing value
	end try
end getWorkspaceRouteFromHint

on getWorkspaceRoute(workspaceName, sidebarGroup)
	if my routeBudgetExpired() then return missing value
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
	set hintedRoute to my getWorkspaceRouteFromHint(workspaceName, sidebarGroup)
	if hintedRoute is not missing value then return hintedRoute
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
			if my routeBudgetExpired() then return missing value
			set workspaceContainer to item containerIndex of sidebarElements
			try
				set workspaceElements to UI elements of workspaceContainer
				set containerChildCount to count of workspaceElements
				set containerRoutes to {}
				set containerSelectedCount to 0
				set currentRepositoryMatches to my targetRepositoryName is ""
				set bulkReady to false
				try
					set candidateRoles to role of UI elements of workspaceContainer
					set candidateNames to name of UI elements of workspaceContainer
					set candidateClassLists to value of attribute "AXDOMClassList" of UI elements of workspaceContainer
					if (count of candidateRoles) is containerChildCount and (count of candidateNames) is containerChildCount and (count of candidateClassLists) is containerChildCount then set bulkReady to true
				end try
				if bulkReady then
					repeat with linkIndex from 1 to containerChildCount
						if my routeBudgetExpired() then return missing value
						try
							set candidate to item linkIndex of workspaceElements
							set candidateRole to item linkIndex of candidateRoles as text
							set candidateName to item linkIndex of candidateNames as text
							if candidateRole is "AXButton" and candidateName ends with " Repo settings New workspace" then set currentRepositoryMatches to my repositoryHeaderMatches(my targetRepositoryName, candidateName)
							set candidateClasses to item linkIndex of candidateClassLists
							set candidateResult to my inspectWorkspaceCandidate(workspaceName, candidate, candidateRole, candidateName, candidateClasses, currentRepositoryMatches, containerIndex, linkIndex, sidebarChildCount, containerChildCount)
							set containerSelectedCount to containerSelectedCount + (item 1 of candidateResult)
							if item 2 of candidateResult is not missing value then copy item 2 of candidateResult to end of containerRoutes
						on error
							set bulkReady to false
							exit repeat
						end try
					end repeat
				end if
				if bulkReady is false then
					set containerRoutes to {}
					set containerSelectedCount to 0
					set currentRepositoryMatches to my targetRepositoryName is ""
					repeat with linkIndex from 1 to containerChildCount
						if my routeBudgetExpired() then return missing value
						set candidate to item linkIndex of workspaceElements
						set candidateRole to role of candidate as text
						if candidateRole is "AXButton" then
							set candidateName to name of candidate as text
							if candidateName ends with " Repo settings New workspace" then set currentRepositoryMatches to my repositoryHeaderMatches(my targetRepositoryName, candidateName)
						else if candidateRole is "AXLink" then
							set candidateClasses to value of attribute "AXDOMClassList" of candidate
							set candidateName to name of candidate as text
							set candidateResult to my inspectWorkspaceCandidate(workspaceName, candidate, candidateRole, candidateName, candidateClasses, currentRepositoryMatches, containerIndex, linkIndex, sidebarChildCount, containerChildCount)
							set containerSelectedCount to containerSelectedCount + (item 1 of candidateResult)
							if item 2 of candidateResult is not missing value then copy item 2 of candidateResult to end of containerRoutes
						end if
					end repeat
				end if
				set selectedWorkspaceCount to selectedWorkspaceCount + containerSelectedCount
				repeat with containerRoute in containerRoutes
					copy containerRoute to end of matchingRoutes
				end repeat
			on error
				return missing value
			end try
		end repeat
	end tell
	if (count of matchingRoutes) is not 1 then return missing value
	if selectedWorkspaceCount is greater than 1 then return missing value
	(* A neutral Dashboard or restored window can expose the exact sidebar with
	no selected workspace. Repository identity makes that route unique and safe
	to press. Keep the older fail-closed rule for unscoped callers. *)
	if selectedWorkspaceCount is 0 and my targetRepositoryName is "" then return missing value
	return item 1 of matchingRoutes
end getWorkspaceRoute

on getSessionTabs()
	if my routeBudgetExpired() then return {}
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return {}
	tell application "System Events"
		try
			set mainElements to UI elements of mainGroup
			set mainCount to count of mainElements
			set mainRoles to missing value
			try
				set candidateMainRoles to role of UI elements of mainGroup
				if (count of candidateMainRoles) is mainCount then set mainRoles to candidateMainRoles
			end try
			set tabGroup to missing value
			repeat with mainIndex from 1 to mainCount
				if my routeBudgetExpired() then return {}
				set candidate to item mainIndex of mainElements
				if mainRoles is not missing value then
					set candidateRole to item mainIndex of mainRoles as text
				else
					set candidateRole to ""
					try
						set candidateRole to role of candidate as text
					end try
				end if
				if candidateRole is "AXTabGroup" then
					set tabGroup to candidate
					exit repeat
				end if
			end repeat
			if tabGroup is missing value then return {}

			set tabGroupChildren to UI elements of tabGroup
			set childCount to count of tabGroupChildren
			set childRoles to missing value
			try
				set candidateChildRoles to role of UI elements of tabGroup
				if (count of candidateChildRoles) is childCount then set childRoles to candidateChildRoles
			end try
			set sessionTabs to {}
			repeat with childIndex from 1 to childCount
				if my routeBudgetExpired() then return {}
				set tabGroupChild to item childIndex of tabGroupChildren
				if childRoles is not missing value then
					set childRole to item childIndex of childRoles as text
				else
					set childRole to ""
					try
						set childRole to role of tabGroupChild as text
					end try
				end if
				if childRole is "AXRadioButton" then
					copy tabGroupChild to end of sessionTabs
				else
					try
						set tabGroupElements to UI elements of tabGroupChild
						set nestedCount to count of tabGroupElements
						set nestedRoles to missing value
						try
							set candidateNestedRoles to role of UI elements of tabGroupChild
							if (count of candidateNestedRoles) is nestedCount then set nestedRoles to candidateNestedRoles
						end try
						repeat with nestedIndex from 1 to nestedCount
							if my routeBudgetExpired() then return {}
							set tabGroupElement to item nestedIndex of tabGroupElements
							if nestedRoles is not missing value then
								set nestedRole to item nestedIndex of nestedRoles as text
							else
								set nestedRole to ""
								try
									set nestedRole to role of tabGroupElement as text
								end try
							end if
							if nestedRole is "AXRadioButton" then copy tabGroupElement to end of sessionTabs
						end repeat
					end try
				end if
			end repeat
			return sessionTabs
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
	if my routeBudgetExpired() then return false
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
	if my routeBudgetExpired() then return false
	tell application "System Events"
		set sessionTabs to my getSessionTabs()
		set tabCount to count of sessionTabs
		set matchedCount to 0
		set tabNames to missing value
		set tabValues to missing value
		try
			set candidateTabNames to name of every item of sessionTabs
			set candidateTabValues to value of every item of sessionTabs
			if (count of candidateTabNames) is tabCount and (count of candidateTabValues) is tabCount then
				set normalizedTabNames to {}
				set normalizedTabValues to {}
				repeat with tabIndex from 1 to tabCount
					if my routeBudgetExpired() then return false
					set normalizedTabName to item tabIndex of candidateTabNames as text
					set normalizedTabValue to item tabIndex of candidateTabValues as boolean
					set end of normalizedTabNames to normalizedTabName
					set end of normalizedTabValues to normalizedTabValue
				end repeat
				set tabNames to normalizedTabNames
				set tabValues to normalizedTabValues
			end if
		end try
		if tabNames is not missing value then
			repeat with tabIndex from 1 to tabCount
				if my routeBudgetExpired() then return false
				if (item tabIndex of tabNames as text) is ("Close chat " & sessionTitle) then
					set matchedCount to matchedCount + 1
					if matchedCount is sessionOrdinal then return item tabIndex of tabValues as boolean
				end if
			end repeat
			return false
		end if
		repeat with candidate in sessionTabs
			if my routeBudgetExpired() then return false
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
		set helperResult to do shell script "/usr/bin/env -u POCKET_ROUTE_DEADLINE_AT " & routeEnvironment & " POCKET_PRESS_MARKER_PATH=" & quoted form of pressMarkerPath & " POCKET_OPERATION=type-and-send /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		if errorText contains "draft_conflict" then return "draft_conflict"
		if errorText contains "session_locked" then return "session_locked"
		-- The helper throws typed codes; passing them through names exactly
		-- which AX assumption broke instead of collapsing every distinct
		-- failure into automation_failed. The list mirrors the codes the
		-- helper actually throws; anything unrecognized still falls through.
		-- deadline_exceeded is the helper bounding its own lifetime so the
		-- transport kill can never orphan it mid-send.
		repeat with knownCode in {"send_unavailable", "automation_budget_exhausted", "composer_tree_transient", "user_input_active", "route_changed", "composer_focus_changed", "draft_changed", "composer_update_failed", "invalid_encoding", "unicode_roundtrip_failed", "target_not_active", "deadline_exceeded"}
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

on selectedRouteHint(inputScriptPath, conductorPid)
	if my routeBudgetExpired() then return missing value
	try
		set helperResult to do shell script "/usr/bin/env POCKET_ROUTE_DEADLINE_AT=" & quoted form of my routeDeadlineAt & " POCKET_WORKSPACE_HINT_CONTAINER_INDEX='' POCKET_WORKSPACE_HINT_LINK_INDEX='' POCKET_WORKSPACE_HINT_SIDEBAR_CHILD_COUNT='' POCKET_WORKSPACE_HINT_CONTAINER_CHILD_COUNT='' POCKET_OPERATION=route-check /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error
		return missing value
	end try
	if helperResult does not start with "ready:" then return missing value
	set originalDelimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to ":"
	set routeParts to text items of helperResult
	set AppleScript's text item delimiters to originalDelimiters
	if (count of routeParts) is not 5 then return missing value
	try
		set containerIndex to item 2 of routeParts as integer
		set linkIndex to item 3 of routeParts as integer
		set sidebarChildCount to item 4 of routeParts as integer
		set containerChildCount to item 5 of routeParts as integer
		if containerIndex < 0 or linkIndex < 0 then return missing value
		if sidebarChildCount <= containerIndex or containerChildCount <= linkIndex then return missing value
		return {containerIndex, linkIndex, sidebarChildCount, containerChildCount}
	on error
		return missing value
	end try
end selectedRouteHint

set operationMode to system attribute "POCKET_OPERATION"
set inputScriptPath to system attribute "POCKET_INPUT_SCRIPT"
set pressMarkerPath to system attribute "POCKET_PRESS_MARKER_PATH"
set my routeDeadlineAt to system attribute "POCKET_ROUTE_DEADLINE_AT"
if operationMode is "send" then set my routeDeadline to (current date) + 12

tell application "System Events"
	if UI elements enabled is false then return "{\"ok\":false,\"code\":\"accessibility_disabled\"}"
	if not (exists process "Conductor") then return "{\"ok\":false,\"code\":\"conductor_not_running\"}"
	tell process "Conductor"
		if not (exists front window) then
			if my restoreConductorWindow() is false then return "{\"ok\":false,\"code\":\"conductor_window_unavailable\"}"
		end if
		set conductorPid to unix id
	end tell
end tell

if operationMode is "doctor" then
	set textArea to getTextArea()
	if textArea is missing value then
		return "{\"ok\":false,\"code\":\"composer_unavailable\"}"
	end if
	return "{\"ok\":true,\"code\":\"ready\"}"
end if

set workspaceName to my decodeBase64(system attribute "POCKET_WORKSPACE_NAME_BASE64")
set my targetRepositoryName to my decodeBase64(system attribute "POCKET_REPOSITORY_NAME_BASE64")
set my workspaceHintContainerIndex to system attribute "POCKET_WORKSPACE_HINT_CONTAINER_INDEX"
set my workspaceHintLinkIndex to system attribute "POCKET_WORKSPACE_HINT_LINK_INDEX"
set my workspaceHintSidebarChildCount to system attribute "POCKET_WORKSPACE_HINT_SIDEBAR_CHILD_COUNT"
set my workspaceHintContainerChildCount to system attribute "POCKET_WORKSPACE_HINT_CONTAINER_CHILD_COUNT"
set sessionTitle to my decodeBase64(system attribute "POCKET_SESSION_TITLE_BASE64")
set sessionOrdinal to (system attribute "POCKET_SESSION_ORDINAL") as integer
set messageText to my decodeBase64(system attribute "POCKET_MESSAGE_BASE64")
set replaceDraft to (system attribute "POCKET_REPLACE_DRAFT") is "true"
set expectedDraft to my decodeBase64(system attribute "POCKET_EXPECTED_DRAFT_BASE64")
set retryInputCounters to system attribute "POCKET_EXPECTED_INPUT_COUNTERS"
set my projectExpansionAttempted to false

set inputReadiness to my waitForInputIdle(inputScriptPath, conductorPid)
if inputReadiness is "busy" then return "{\"ok\":false,\"code\":\"user_input_active\"}"
if inputReadiness is "session_locked" then return "{\"ok\":false,\"code\":\"session_locked\"}"
if inputReadiness is not "ready" then return "{\"ok\":false,\"code\":\"input_helper_unavailable\"}"

set selectedHint to missing value
if operationMode is "send" then set selectedHint to my selectedRouteHint(inputScriptPath, conductorPid)
if my routeBudgetDidExpire then return my routeBudgetFailure()
if selectedHint is missing value then
	(* Conductor can land on Dashboard after a restart. When the exact route is
	not already selected, recover through the full navigation and proof path. *)
	if getMainGroup() is missing value then
		if my routeBudgetExpired() then return my routeBudgetFailure()
		set escaped to my escapeDashboard(workspaceName)
		if my routeBudgetDidExpire then return my routeBudgetFailure()
		if escaped then
			repeat with waitIndex from 1 to 40
				if my routeBudgetExpired() then return my routeBudgetFailure()
				if getMainGroup() is not missing value then exit repeat
				delay 0.25
			end repeat
		end if
	end if

	set sidebarGroup to getSidebarGroup()
	if my routeBudgetDidExpire then return my routeBudgetFailure()
	if sidebarGroup is missing value then return my workspaceListFailure(inputScriptPath, conductorPid)
	set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)
	if my routeBudgetDidExpire then return my routeBudgetFailure()
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
			if my routeBudgetExpired() then return my routeBudgetFailure()
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
		if my routeBudgetDidExpire then return my routeBudgetFailure()
		if sidebarGroup is missing value then return my workspaceListFailure(inputScriptPath, conductorPid)
		set workspaceRoute to my getWorkspaceRoute(workspaceName, sidebarGroup)
		if my routeBudgetDidExpire then return my routeBudgetFailure()
		if workspaceRoute is missing value then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
		set workspaceLink to item 1 of workspaceRoute
		set workspaceContainerIndex to item 2 of workspaceRoute
		set workspaceLinkIndex to item 3 of workspaceRoute
		set sidebarChildCount to item 4 of workspaceRoute
		set containerChildCount to item 5 of workspaceRoute
	end if

	set stableRouteChecks to 0
	if routeAlreadySelected is true and operationMode is "send" then
		(* The inner helper proves the pinned route again immediately before press. *)
		set stableRouteChecks to 3
	else
		set my heldMainGroup to getMainGroup()
		repeat with waitIndex from 1 to 50
			if my routeBudgetExpired() then return my routeBudgetFailure()
			delay 0.1
			if my workspaceLinkIsSelected(workspaceLink, workspaceName) and my sessionIsSelected(sessionTitle, sessionOrdinal) then
				set stableRouteChecks to stableRouteChecks + 1
				if stableRouteChecks is 3 then exit repeat
			else
				set stableRouteChecks to 0
			end if
		end repeat
		set my heldMainGroup to missing value
	end if
	if my routeBudgetExpired() then return my routeBudgetFailure()
	if stableRouteChecks is not 3 then return "{\"ok\":false,\"code\":\"session_not_visible\"}"
else
	set workspaceContainerIndex to item 1 of selectedHint
	set workspaceLinkIndex to item 2 of selectedHint
	set sidebarChildCount to item 3 of selectedHint
	set containerChildCount to item 4 of selectedHint
end if
set my heldMainGroup to missing value

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
		set rootsAfter to my webRootCount()
		my closeAnyMenu()
		-- Conductor's model and effort dropdowns render without exposing their
		-- items to accessibility: the root count changes but not one labelled
		-- element appears anywhere in the tree (verified three ways: new-root
		-- scan, deep nested walk, and a full before/after label-set diff).
		-- Returning ok with an empty list would let the phone show "no options"
		-- as though that were the truth, so say plainly that the menu opened
		-- and could not be read instead.
		if (count of foundItems) is 0 then
			if rootsAfter is not rootsBefore then
				return "{\"ok\":false,\"code\":\"menu_not_readable\"}"
			end if
			return "{\"ok\":false,\"code\":\"menu_did_not_open\"}"
		end if
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
	-- Cmd-T. Verified live: creates a chat in the CURRENT workspace, which the
	-- route proof above has already selected. A shortcut is used deliberately
	-- rather than hunting a button: the tab strip's trailing control does
	-- nothing when pressed, and every icon-only control in this app is
	-- unlabelled and has moved between releases, which is the exact pattern
	-- that broke sending twice. A shortcut has no CSS classes to rot.
	-- getSessionTabs returns an empty list when the main group cannot be
	-- resolved, which a re-render blip can cause. Taken as a baseline that
	-- reads as zero, and the very next successful read then looks like a tab
	-- appeared, so a false tab_created was reported and no chat existed. The
	-- route proof above already selected a session, so at least one tab must
	-- exist: a zero baseline is a failed read, not an empty window.
	set beforeTabs to count of my getSessionTabs()
	if beforeTabs is 0 then return "{\"ok\":false,\"code\":\"tab_not_created\"}"
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
	end tell
	delay 0.2
	set pressError to ""
	try
		do shell script "/usr/bin/env POCKET_OPERATION=tab-new /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		set pressError to errorText
	end try
	-- Observe before classifying, even when the helper reported an error. The
	-- shortcut is posted before the final lease and unlock assertions, so a
	-- throw after delivery used to return control_press_failed, which is
	-- retry-safe, and the retry created a SECOND chat. What decides the
	-- outcome is whether a tab actually appeared, not whether the helper threw.
	repeat with waitIndex from 1 to 30
		delay 0.1
		if (count of my getSessionTabs()) > beforeTabs then
			return "{\"ok\":true,\"code\":\"tab_created\"}"
		end if
	end repeat
	if pressError is not "" then
		if pressError contains "user_input_active" then return "{\"ok\":false,\"code\":\"user_input_active\"}"
		if pressError contains "session_locked" then return "{\"ok\":false,\"code\":\"session_locked\"}"
		return "{\"ok\":false,\"code\":\"control_press_failed\"}"
	end if
	return "{\"ok\":false,\"code\":\"tab_not_created\"}"
end if

if operationMode is "tab-close" then
	-- Irreversible. Cmd-W closes the SELECTED tab, so this is only safe because
	-- the route proof above has already selected exactly the requested session
	-- and held it stable. Re-verify that selection immediately before the
	-- shortcut, refuse without an explicit confirmation token, and then prove
	-- afterwards that exactly one tab went away and it was the right one.
	if (system attribute "POCKET_CONFIRM_CLOSE") is not "yes" then
		return "{\"ok\":false,\"code\":\"close_not_confirmed\"}"
	end if
	if my sessionIsSelected(sessionTitle, sessionOrdinal) is false then
		return "{\"ok\":false,\"code\":\"session_not_visible\"}"
	end if
	set wantedTabName to "Close chat " & sessionTitle
	set beforeTabs to count of my getSessionTabs()
	set beforeMatching to 0
	repeat with candidate in my getSessionTabs()
		try
			if (name of candidate as text) is wantedTabName then set beforeMatching to beforeMatching + 1
		end try
	end repeat
	if beforeMatching < sessionOrdinal then return "{\"ok\":false,\"code\":\"session_not_visible\"}"
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
	end tell
	delay 0.2
	try
		do shell script "/usr/bin/env POCKET_OPERATION=tab-close /usr/bin/osascript -l JavaScript " & quoted form of inputScriptPath & " " & (conductorPid as text)
	on error errorText
		if errorText contains "user_input_active" then return "{\"ok\":false,\"code\":\"user_input_active\"}"
		if errorText contains "session_locked" then return "{\"ok\":false,\"code\":\"session_locked\"}"
		return "{\"ok\":false,\"code\":\"control_press_failed\"}"
	end try
	repeat with waitIndex from 1 to 30
		delay 0.1
		set afterTabs to count of my getSessionTabs()
		if afterTabs < beforeTabs then
			set afterMatching to 0
			repeat with candidate in my getSessionTabs()
				try
					if (name of candidate as text) is wantedTabName then set afterMatching to afterMatching + 1
				end try
			end repeat
			if afterTabs is (beforeTabs - 1) and afterMatching is (beforeMatching - 1) then
				return "{\"ok\":true,\"code\":\"tab_closed\"}"
			end if
			return "{\"ok\":false,\"code\":\"tab_close_unverified\"}"
		end if
	end repeat
	return "{\"ok\":false,\"code\":\"tab_not_closed\"}"
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

if selectedHint is missing value then
	if my workspaceLinkIsSelected(workspaceLink, workspaceName) is false then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
	if my sessionIsSelected(sessionTitle, sessionOrdinal) is false then return "{\"ok\":false,\"code\":\"session_not_visible\"}"
end if
set my heldMainGroup to missing value

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
	return "{\"ok\":true,\"code\":\"sent\",\"pressedAt\":" & pressedAt & ",\"composerOwned\":true,\"workspaceHint\":{\"containerIndex\":" & (workspaceContainerIndex as text) & ",\"linkIndex\":" & (workspaceLinkIndex as text) & ",\"sidebarChildCount\":" & (sidebarChildCount as text) & ",\"containerChildCount\":" & (containerChildCount as text) & "}}"
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
