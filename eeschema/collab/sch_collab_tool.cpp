/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#include "sch_collab_tool.h"

#include "sch_collab_sync.h"

#include <widgets/wx_infobar.h>
#include <wx/hyperlink.h>
#include <collab/collab_project.h>
#include <collab/collab_rest.h>
#include <dialogs/dialog_collab_comments.h>
#include <widgets/collab_history_panel.h>
#include <kiid.h>
#include <math/util.h>
#include <sch_screen.h>
#include <sch_sheet_path.h>
#include <schematic.h>
#include <sch_line.h>
#include <tools/sch_actions.h>
#include <tools/sch_line_wire_bus_tool.h>
#include <gal/graphics_abstraction_layer.h>
#include <view/view.h>
#include <view/view_controls.h>

#include <wx/app.h>
#include <wx/clipbrd.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/msgdlg.h>
#include <wx/textdlg.h>

static const wxChar* const traceCollab = wxT( "COLLAB" );

namespace
{
long long jsonNumber( const nlohmann::json& aObj, const char* aKey, long long aDefault )
{
    auto it = aObj.find( aKey );

    return it != aObj.end() && it->is_number() ? it->get<long long>() : aDefault;
}
} // anonymous namespace



/// Cap on how many selection boxes ride along in a presence update; the server
/// rejects presence payloads over 8 KB.
static constexpr size_t MAX_PRESENCE_BOXES = 150;

/// Cap on in-flight ghost segments per presence update (same 8 KB budget).
static constexpr size_t MAX_GHOST_SEGS = 100;

/// Cap on full item ghosts rendered per peer (painter calls are not free).
static constexpr size_t MAX_GHOST_ITEMS = 40;


SCH_COLLAB_TOOL::SCH_COLLAB_TOOL() :
        SCH_TOOL_BASE<SCH_EDIT_FRAME>( "eeschema.Collab" ),
        m_presenceDirty( false )
{
    m_timer.SetOwner( this );
    Bind( wxEVT_TIMER, &SCH_COLLAB_TOOL::onTimer, this );
}


SCH_COLLAB_TOOL::~SCH_COLLAB_TOOL()
{
    m_timer.Stop();

    // The session is process-wide and outlives every frame, so a registration
    // left behind here is a dangling COLLAB_DOC_ADAPTER*.
    if( COLLAB_SESSION::Exists() )
        COLLAB_SESSION::Get().ForgetAdapter( this );
}


void SCH_COLLAB_TOOL::Reset( RESET_REASON aReason )
{
    SCH_TOOL_BASE<SCH_EDIT_FRAME>::Reset( aReason );

    if( aReason == SHUTDOWN )
    {
        // Leave the session while the frame and view are still alive; the tool
        // destructor runs too late to touch either.
        if( sessionActive() )
            endSession();

        return;
    }

    // A schematic (re)load rebuilds the view contents, dropping our overlay item;
    // the next rebuildOverlay() re-adds it.

    // A cloud project copy records its server project beside the files; rejoin
    // the live session automatically.  Deferred so the load fully completes first.
    if( aReason == RUN || aReason == MODEL_RELOAD || aReason == SUPERMODEL_RELOAD )
    {
        if( !sessionActive() && m_frame
            && m_autoJoinProject != m_frame->Prj().GetProjectPath() )
        {
            CallAfter(
                    [this]()
                    {
                        tryAutoJoin();
                    } );
        }
    }
}


void SCH_COLLAB_TOOL::tryAutoJoin()
{
    if( sessionActive() || !m_frame )
        return;

    wxString projectPath = m_frame->Prj().GetProjectPath();

    if( projectPath.IsEmpty() || m_autoJoinProject == projectPath )
        return;

    m_autoJoinProject = projectPath;

    wxString server;
    wxString projectId = COLLAB_PROJECT::ReadLocalLink( projectPath,
                                                        m_frame->Prj().GetProjectName(), server );

    if( projectId.IsEmpty() || server != COLLAB_SESSION::ServerUrl() )
        return;

    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
    {
        showOfflineBanner( _( "you are not signed in" ) );
        return;
    }

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( session.GetState() != COLLAB_SESSION::STATE::DISCONNECTED )
    {
        // Another editor in this process already connected the session; join our
        // docs from the published doc list without reconnecting.
        if( session.ProjectDocs().is_array() && !session.ProjectDocs().empty() )
        {
            nlohmann::json project = { { "docs", session.ProjectDocs() } };
            beginSession( project, token, wxEmptyString, false );
        }

        return;
    }

    std::optional<nlohmann::json> project = COLLAB_REST::GetProject( server, token, projectId );

    if( project )
    {
        wxLogTrace( traceCollab, wxS( "auto-joining cloud project %s" ), projectId );
        beginSession( *project, token, wxEmptyString );
    }
    else
    {
        showOfflineBanner( _( "the online project could not be reached" ) );
    }
}


void SCH_COLLAB_TOOL::showOfflineBanner( const wxString& aWhy )
{
    WX_INFOBAR* infoBar = m_frame->GetInfoBar();

    infoBar->RemoveAllButtons();
    infoBar->AddLink( _( "Reconnect" ),
                      [this]( wxHyperlinkEvent& )
                      {
                          m_autoJoinProject.clear();
                          withSignIn( [this]( const wxString& ) { tryAutoJoin(); } );
                      } );
    infoBar->AddLink( _( "Make local only" ),
                      [this]( wxHyperlinkEvent& )
                      {
                          unlinkFromOnline();
                      } );
    infoBar->AddCloseButton();
    infoBar->ShowMessage( wxString::Format( _( "This is a copy of an online project and you "
                                               "are editing it offline (%s).  Your edits are "
                                               "merged with the online version when you "
                                               "reconnect." ),
                                            aWhy ),
                          wxICON_WARNING );
    m_offlineBanner = true;
}


void SCH_COLLAB_TOOL::unlinkFromOnline()
{
    if( wxMessageBox( _( "Stop syncing this copy with the online project?\n\nThe online "
                         "project stays as it is; this folder becomes a plain local project." ),
                      _( "Make Project Local" ), wxYES_NO | wxICON_QUESTION, m_frame )
        != wxYES )
    {
        return;
    }

    if( sessionActive() )
        endSession();

    wxString projectPath = m_frame->Prj().GetProjectPath();

    COLLAB_PROJECT::UnlinkLocalProject( projectPath, m_frame->Prj().GetProjectName() );
    m_autoJoinProject = projectPath;    // and no auto-join for it from now on

    m_offlineBanner = false;
    m_frame->GetInfoBar()->Dismiss();
    m_frame->ShowInfoBarMsg( _( "This project is now local only." ) );
    m_frame->SetStatusText( wxEmptyString, 0 );
}


int SCH_COLLAB_TOOL::StartSession( const TOOL_EVENT& aEvent )
{
    withSignIn(
            [this]( const wxString& aToken )
            {
                startWithToken( aToken );
            } );

    return 0;
}


int SCH_COLLAB_TOOL::JoinSession( const TOOL_EVENT& aEvent )
{
    wxTextEntryDialog dlg( m_frame, _( "Share link or invite token:" ),
                           _( "Join Shared Project" ) );

    if( dlg.ShowModal() != wxID_OK )
        return 0;

    wxString linkToken = COLLAB_PROJECT::ParseLinkToken( dlg.GetValue() );

    if( linkToken.IsEmpty() )
    {
        m_frame->ShowInfoBarError( _( "The share link could not be understood." ) );
        return 0;
    }

    withSignIn(
            [this, linkToken]( const wxString& aToken )
            {
                joinWithToken( aToken, linkToken );
            } );

    return 0;
}


int SCH_COLLAB_TOOL::LeaveSession( const TOOL_EVENT& aEvent )
{
    endSession();
    m_frame->SetStatusText( wxEmptyString, 0 );

    return 0;
}


void SCH_COLLAB_TOOL::withSignIn( std::function<void( const wxString& aToken )> aContinuation )
{
    wxString token = COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() );

    if( !token.IsEmpty() )
    {
        aContinuation( token );
        return;
    }

    wxString error;

    bool started = m_auth.SignIn(
            COLLAB_SESSION::ServerUrl(),
            [this, aContinuation]( bool aSuccess, const wxString& aTokenOrError )
            {
                if( aSuccess )
                    aContinuation( aTokenOrError );
                else
                    m_frame->ShowInfoBarError( aTokenOrError );
            },
            error );

    if( !started )
        m_frame->ShowInfoBarError( error );
}


void SCH_COLLAB_TOOL::joinWithToken( const wxString& aToken, const wxString& aLinkToken )
{
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::ClaimAndFetch( COLLAB_SESSION::ServerUrl(), aToken, aLinkToken,
                                           error );

    if( !project )
    {
        m_frame->ShowInfoBarError( error );
        return;
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( m_frame->Prj().GetProjectPath(),
                                    m_frame->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );
    COLLAB_PROJECT::RecordLocalCopy( wxString::FromUTF8( project->value( "projectId", "" ) ),
                                     m_frame->Prj().GetProjectFullName() );

    beginSession( *project, aToken, aLinkToken );
}


void SCH_COLLAB_TOOL::startWithToken( const wxString& aToken )
{
    wxString url;
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::CreateAndShare( COLLAB_SESSION::ServerUrl(), aToken,
                                            m_frame->Prj().GetProjectPath(),
                                            m_frame->Prj().GetProjectName(), url, error );

    if( !project )
    {
        m_frame->ShowInfoBarError( error );
        return;
    }

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }

    // Remember the pairing so this copy rejoins automatically next time.
    COLLAB_PROJECT::WriteLocalLink( m_frame->Prj().GetProjectPath(),
                                    m_frame->Prj().GetProjectName(),
                                    COLLAB_SESSION::ServerUrl(),
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );
    COLLAB_PROJECT::RecordLocalCopy( wxString::FromUTF8( project->value( "projectId", "" ) ),
                                     m_frame->Prj().GetProjectFullName() );

    beginSession( *project, aToken, wxEmptyString );

    // An infobar, not a modal: a message box here wedges scripted flows, and
    // File > Copy Share Link can re-mint the link at any time.
    m_frame->ShowInfoBarMsg(
            wxString::Format( _( "Session started — share link copied to the clipboard: %s" ),
                              url ) );
}


void SCH_COLLAB_TOOL::beginSession( const nlohmann::json& aProject, const wxString& aToken,
                                    const wxString& aLinkToken, bool aConnect )
{
    if( aConnect )
        endSession();

    // Publish the full doc list so the board editor can find and join its own doc.
    COLLAB_SESSION::Get().SetProjectDocs( aProject.value( "docs", nlohmann::json::array() ) );
    COLLAB_SESSION::Get().SetProjectId(
            wxString::FromUTF8( aProject.value( "projectId", "" ) ) );

    if( aProject.contains( "docs" ) && aProject[ "docs" ].is_array() )
    {
        for( const nlohmann::json& doc : aProject[ "docs" ] )
        {
            if( doc.value( "docType", "" ) != "kicad_sch" )
                continue;

            wxString docId = wxString::FromUTF8( doc.value( "docId", "" ) );
            wxString path = wxString::FromUTF8( doc.value( "path", "" ) );

            if( docId.IsEmpty() || path.IsEmpty() )
                continue;

            m_docIdByPath[ path ] = docId;
            m_pathByDocId[ docId ] = path;
        }
    }

    if( m_pathByDocId.empty() )
    {
        m_frame->ShowInfoBarError( _( "The shared project contains no schematic documents." ) );
        return;
    }

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( aConnect )
        session.Connect( aToken, aLinkToken );

    // The sync engine must exist before the joins so it sees the join-time messages.
    m_sync = std::make_unique<SCH_COLLAB_SYNC>( m_frame, m_docIdByPath );
    m_sync->SetAdapter( this );

    // Picks up ops left unacknowledged by a previous run (crash, or offline edits).
    m_sync->OpenJournal( m_frame->Prj().GetProjectPath(), m_frame->Prj().GetProjectName() );

    for( const auto& [docId, path] : m_pathByDocId )
        session.JoinDoc( docId, std::nullopt, this );

    fetchComments();

    // Surface the version history beside the canvas for the session.
    if( COLLAB_HISTORY_PANEL* panel = historyPanel() )
    {
        m_frame->GetAuiManager().GetPane( panel ).Show();
        m_frame->GetAuiManager().Update();
    }

    // Live cursors only appear when both sides display the same file.
    if( m_docIdByPath.find( currentSheetFile() ) == m_docIdByPath.end() )
    {
        m_frame->ShowInfoBarMsg( _( "Joined the shared project.  Open the same project locally "
                                    "to see live cursors." ) );
    }

    m_lastSheetFile = currentSheetFile();
    m_timer.Start( 100 );
    OnSessionStateChanged();
}


void SCH_COLLAB_TOOL::OnProjectSaved()
{
    // A save while live with every op of ours acknowledged puts the server's
    // state on disk: that is the base the next offline merge starts from.
    if( m_sync && COLLAB_SESSION::Get().IsLive() )
        m_sync->RefreshSyncBasesFromDisk();
}


void SCH_COLLAB_TOOL::endSession()
{
    m_cachedShareLink.clear();
    m_timer.Stop();
    m_sync.reset();

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    for( const auto& [docId, path] : m_pathByDocId )
        session.LeaveDoc( docId );

    session.Disconnect();

    m_docIdByPath.clear();
    m_pathByDocId.clear();
    m_lastSentState = nlohmann::json();
    m_lastSentDocId.clear();
    m_presenceDirty = false;

    if( KIGFX::VIEW* view = getView() )
    {
        m_cursorItem.SetPeers( {} );
        view->Remove( &m_cursorItem );

        if( m_frame->GetCanvas() )
            m_frame->GetCanvas()->Refresh();
    }
}


wxString SCH_COLLAB_TOOL::currentSheetFile() const
{
    if( !m_frame || !m_frame->GetScreen() )
        return wxEmptyString;

    wxFileName fn( m_frame->GetScreen()->GetFileName() );
    fn.MakeRelativeTo( m_frame->Prj().GetProjectPath() );

    return fn.GetFullPath( wxPATH_UNIX );
}


wxString SCH_COLLAB_TOOL::currentDocId() const
{
    auto it = m_docIdByPath.find( currentSheetFile() );

    return it == m_docIdByPath.end() ? wxString() : it->second;
}


int SCH_COLLAB_TOOL::onSelectionChange( const TOOL_EVENT& aEvent )
{
    m_presenceDirty = true;

    // A click that selected nothing may be a comment-pin or peer-cursor hit:
    // both live on the overlay, invisible to the selection tool.
    if( aEvent.Matches( EVENTS::ClearedEvent ) && m_frame && m_frame->GetCanvas() )
    {
        VECTOR2I cursor = m_frame->GetCanvas()->GetViewControls()->GetCursorPosition( false );

        long long root = pinAt( cursor );

        if( root >= 0 )
        {
            openThread( root );
            return 0;
        }

        wxString peer = peerCursorAt( cursor );

        if( !peer.IsEmpty() )
        {
            if( m_followPeer == peer )
            {
                m_followPeer.clear();
                m_frame->ShowInfoBarMsg( _( "Stopped following." ) );
            }
            else
            {
                m_followPeer = peer;
                m_followApplied = BOX2D();
                m_frame->ShowInfoBarMsg( _( "Following — pan or zoom to stop." ) );
                applyFollow();
            }
        }
    }

    return 0;
}


long long SCH_COLLAB_TOOL::pinAt( const VECTOR2I& aPos ) const
{
    KIGFX::VIEW* view = getView();
    wxString     docId = currentDocId();

    if( !view || docId.IsEmpty() )
        return -1;

    auto docIt = m_commentsByDoc.find( docId );

    if( docIt == m_commentsByDoc.end() )
        return -1;

    double radius = 14.0 / view->GetGAL()->GetWorldScale();

    long long best = -1;
    double    bestDist = radius;

    for( const nlohmann::json& c : docIt->second )
    {
        if( !c.is_object() || jsonNumber( c, "parentId", -1 ) >= 0 )
            continue;

        VECTOR2I pos( jsonNumber( c, "x", 0 ), jsonNumber( c, "y", 0 ) );
        double   dist = ( pos - aPos ).EuclideanNorm();

        if( dist <= bestDist )
        {
            best = jsonNumber( c, "id", -1 );
            bestDist = dist;
        }
    }

    return best;
}


wxString SCH_COLLAB_TOOL::peerCursorAt( const VECTOR2I& aPos ) const
{
    KIGFX::VIEW* view = getView();
    wxString     docId = currentDocId();

    if( !view || docId.IsEmpty() )
        return wxEmptyString;

    double radius = 28.0 / view->GetGAL()->GetWorldScale();

    wxString best;
    double   bestDist = radius;

    for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( docId ) )
    {
        if( !peer.state.is_object() || !peer.state.contains( "cursor" )
            || !peer.state[ "cursor" ].is_array() || peer.state[ "cursor" ].size() < 2 )
        {
            continue;
        }

        VECTOR2I cursor( peer.state[ "cursor" ][ 0 ].get<int>(),
                         peer.state[ "cursor" ][ 1 ].get<int>() );
        double   dist = ( cursor - aPos ).EuclideanNorm();

        if( dist <= bestDist )
        {
            best = clientId;
            bestDist = dist;
        }
    }

    return best;
}


void SCH_COLLAB_TOOL::openThread( long long aRootId )
{
    if( !m_commentsDlg )
    {
        TOOL_EVENT dummy;
        ShowComments( dummy );
    }

    if( m_commentsDlg )
    {
        m_commentsDlg->SelectThread( aRootId );
        m_commentsDlg->Raise();
    }
}


void SCH_COLLAB_TOOL::onTimer( wxTimerEvent& aEvent )
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !sessionActive() || !session.IsLive() || !m_frame )
        return;

    wxString sheetFile = currentSheetFile();

    // Changing sheets changes which peers are visible.
    if( sheetFile != m_lastSheetFile )
    {
        m_lastSheetFile = sheetFile;
        rebuildOverlay();
    }

    auto docIt = m_docIdByPath.find( sheetFile );

    if( docIt == m_docIdByPath.end() )
        return;

    const wxString& docId = docIt->second;

    VECTOR2D cursor = getViewControls()->GetCursorPosition();
    BOX2D    viewport = getView()->GetViewport();

    nlohmann::json selection = nlohmann::json::array();
    nlohmann::json boxes = nlohmann::json::array();

    // Send our own bounding boxes rather than only ids: the receiver would
    // otherwise draw them from its own (last committed) copy, so a drag in
    // progress would not be visible until it was committed.  Sending live
    // geometry is also what lets a peer highlight items it does not have yet.
    for( EDA_ITEM* item : m_selectionTool->GetSelection() )
    {
        selection.push_back( item->m_Uuid.AsStdString() );

        if( boxes.size() < MAX_PRESENCE_BOXES )
        {
            const BOX2I bbox = item->GetBoundingBox();
            boxes.push_back( { bbox.GetX(), bbox.GetY(), bbox.GetWidth(), bbox.GetHeight() } );
        }
    }

    // In-flight wire/bus segments ghost live on peers' canvases.
    nlohmann::json ghost = nlohmann::json::array();

    if( SCH_LINE_WIRE_BUS_TOOL* wireTool = m_toolMgr->GetTool<SCH_LINE_WIRE_BUS_TOOL>() )
    {
        for( SCH_LINE* line : wireTool->GetUnfinishedSegments() )
        {
            if( !line || line->GetStartPoint() == line->GetEndPoint() )
                continue;

            if( ghost.size() >= MAX_GHOST_SEGS )
                break;

            ghost.push_back( { line->GetStartPoint().x, line->GetStartPoint().y,
                               line->GetEndPoint().x, line->GetEndPoint().y,
                               line->GetLineWidth() } );
        }
    }

    nlohmann::json state = {
        { "cursor", { KiROUND( cursor.x ), KiROUND( cursor.y ) } },
        { "viewport",
          { KiROUND( viewport.GetOrigin().x ), KiROUND( viewport.GetOrigin().y ),
            KiROUND( viewport.GetSize().x ), KiROUND( viewport.GetSize().y ) } },
        { "selection", selection },
        { "boxes", boxes },
        { "ghost", ghost },
        { "sheetFile", sheetFile.ToStdString( wxConvUTF8 ) },
        { "sheetPath", m_frame->GetCurrentSheet().PathAsString().ToStdString( wxConvUTF8 ) },
    };

    // Re-send unchanged state as a keepalive: the server evicts peers after 30 s
    // of silence, which would make an idle collaborator's cursor vanish.
    bool keepalive = m_lastPresenceSend.IsValid()
                     && wxDateTime::Now() - m_lastPresenceSend >= wxTimeSpan::Seconds( 10 );

    if( !m_presenceDirty && !keepalive && docId == m_lastSentDocId && state == m_lastSentState )
        return;

    m_presenceDirty = false;
    m_lastSentDocId = docId;
    m_lastSentState = state;
    m_lastPresenceSend = wxDateTime::Now();

    session.SendPresence( docId, state );
}


int SCH_COLLAB_TOOL::FollowNextPeer( const TOOL_EVENT& aEvent )
{
    // Peers across every joined doc: schematics follow across sheets.
    std::map<wxString, COLLAB_PEER> all;

    for( const auto& [path, docId] : m_docIdByPath )
    {
        for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( docId ) )
            all.emplace( clientId, peer );
    }

    if( all.empty() )
    {
        m_frame->ShowInfoBarMsg( _( "No collaborators here to follow." ) );
        return 0;
    }

    auto it = m_followPeer.IsEmpty() ? all.begin() : all.find( m_followPeer );

    if( !m_followPeer.IsEmpty() && it != all.end() )
        ++it;

    if( it == all.end() )
    {
        m_followPeer.clear();
        m_frame->ShowInfoBarMsg( _( "Stopped following." ) );
        return 0;
    }

    m_followPeer = it->first;
    m_followApplied = BOX2D();

    wxString name = it->second.name.IsEmpty() ? it->second.login : it->second.name;
    m_frame->ShowInfoBarMsg(
            wxString::Format( _( "Following %s — pan or zoom to stop." ), name ) );

    applyFollow();
    return 0;
}


void SCH_COLLAB_TOOL::applyFollow()
{
    if( m_followPeer.IsEmpty() || !m_frame )
        return;

    KIGFX::VIEW* view = getView();

    if( !view )
        return;

    // Find the followed peer on whichever doc they currently present on.
    const nlohmann::json* state = nullptr;

    for( const auto& [path, docId] : m_docIdByPath )
    {
        const auto& peers = COLLAB_SESSION::Get().Peers( docId );
        auto        it = peers.find( m_followPeer );

        if( it != peers.end() && it->second.state.is_object() )
        {
            state = &it->second.state;
            break;
        }
    }

    if( !state )
    {
        m_followPeer.clear();
        m_frame->ShowInfoBarMsg( _( "The peer you were following left." ) );
        return;
    }

    // Sheet-follow: switch to the sheet the peer is looking at.
    wxString peerSheet = wxString::FromUTF8( state->value( "sheetFile", "" ) );

    if( !peerSheet.IsEmpty() && peerSheet != currentSheetFile() )
    {
        for( const SCH_SHEET_PATH& path : m_frame->Schematic().Hierarchy() )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !screen )
                continue;

            wxFileName fn( screen->GetFileName() );
            fn.MakeRelativeTo( m_frame->Prj().GetProjectPath() );

            if( fn.GetFullPath( wxPATH_UNIX ) == peerSheet )
            {
                m_frame->SetCurrentSheet( path );
                m_frame->DisplayCurrentSheet();
                m_followApplied = BOX2D();
                break;
            }
        }
    }

    if( !state->contains( "viewport" ) || !( *state )[ "viewport" ].is_array()
        || ( *state )[ "viewport" ].size() < 4 )
    {
        return;
    }

    BOX2D current = view->GetViewport();

    if( m_followApplied.GetWidth() > 0 )
    {
        double tolerance = std::max( 1.0, m_followApplied.GetWidth() * 0.02 );

        if( std::abs( current.GetX() - m_followApplied.GetX() ) > tolerance
            || std::abs( current.GetY() - m_followApplied.GetY() ) > tolerance
            || std::abs( current.GetWidth() - m_followApplied.GetWidth() ) > tolerance )
        {
            m_followPeer.clear();
            m_frame->ShowInfoBarMsg( _( "Stopped following." ) );
            return;
        }
    }

    const nlohmann::json& vp = ( *state )[ "viewport" ];
    BOX2D target( VECTOR2D( vp[ 0 ].get<double>(), vp[ 1 ].get<double>() ),
                  VECTOR2D( vp[ 2 ].get<double>(), vp[ 3 ].get<double>() ) );

    if( target.GetWidth() <= 0 || target.GetHeight() <= 0 )
        return;

    view->SetViewport( target );
    m_followApplied = view->GetViewport();
    m_frame->GetCanvas()->Refresh();
}


void SCH_COLLAB_TOOL::OnPresenceChanged()
{
    // Keep the status-bar collaborator count fresh (only when it changes).
    {
        static thread_local size_t lastCount = SIZE_MAX;
        size_t count = COLLAB_SESSION::Get().Peers( currentDocId() ).size();

        if( count != lastCount )
        {
            lastCount = count;
            OnSessionStateChanged();
        }
    }
    applyFollow();
    rebuildOverlay();
}


void SCH_COLLAB_TOOL::OnRemoteOp( const nlohmann::json& aOpMsg )
{
    if( m_sync )
        m_sync->OnRemoteOp( aOpMsg );
}


void SCH_COLLAB_TOOL::OnOpsTail( const nlohmann::json& aOpsMsg )
{
    if( m_sync )
        m_sync->OnOpsTail( aOpsMsg );
}


void SCH_COLLAB_TOOL::OnSnapshot( const nlohmann::json& aSnapshotMsg )
{
    if( m_sync )
        m_sync->OnSnapshot( aSnapshotMsg );
}


void SCH_COLLAB_TOOL::OnAck( const wxString& aClientOpId, long long aSeq )
{
    if( m_sync )
        m_sync->OnAck( aClientOpId, aSeq );
}


void SCH_COLLAB_TOOL::OnSnapshotRequest()
{
    if( m_sync )
        m_sync->OnSnapshotRequest();
}


void SCH_COLLAB_TOOL::OnReset( const wxString& aDocId, long long aSeq )
{
    if( m_sync )
        m_sync->OnReset( aDocId, aSeq );
}


void SCH_COLLAB_TOOL::OnOpRejected( const wxString& aClientOpId, const wxString& aCode )
{
    if( m_sync )
        m_sync->OnOpRejected( aClientOpId );

    // One notice per burst: a drag can produce several rejected ops at once
    // and each would raise its own infobar otherwise.
    if( m_lastRejectNotice.IsValid()
        && wxDateTime::Now() - m_lastRejectNotice < wxTimeSpan::Seconds( 10 ) )
    {
        return;
    }

    m_lastRejectNotice = wxDateTime::Now();

    if( aCode == wxS( "permission_denied" ) )
    {
        m_frame->ShowInfoBarError(
                _( "You have view-only access to this shared project. Your change was not "
                   "saved and the schematic has been refreshed." ) );
    }
    else
    {
        m_frame->ShowInfoBarError(
                wxString::Format( _( "The server rejected an edit (%s). The schematic has "
                                     "been refreshed." ),
                                  aCode ) );
    }
}


void SCH_COLLAB_TOOL::OnSessionStateChanged()
{
    if( !sessionActive() )
        return;

    wxString msg;

    switch( COLLAB_SESSION::Get().GetState() )
    {
    case COLLAB_SESSION::STATE::LIVE:
    {
        if( m_offlineBanner )
        {
            m_offlineBanner = false;
            m_frame->GetInfoBar()->Dismiss();
        }

        size_t peers = COLLAB_SESSION::Get().Peers( currentDocId() ).size();

        msg = peers > 0 ? wxString::Format( _( "Collaboration: live \u00b7 %zu collaborator(s)" ),
                                            peers )
                        : _( "Collaboration: live" );
        break;
    }
    case COLLAB_SESSION::STATE::CONNECTING:   msg = _( "Collaboration: connecting..." ); break;
    case COLLAB_SESSION::STATE::DISCONNECTED: msg = _( "Collaboration: offline" );       break;
    }

    m_frame->SetStatusText( msg, 0 );

    // A dead token is the one disconnect that never comes back on its own —
    // say so instead of silently sitting at "offline" forever.
    if( COLLAB_SESSION::Get().GetState() == COLLAB_SESSION::STATE::DISCONNECTED
        && COLLAB_SESSION::Get().DisconnectReason() == wxS( "auth_failed" ) )
    {
        m_frame->ShowInfoBarError(
                _( "Collaboration sign-in expired or was revoked, so the live session ended. "
                   "Rejoin from File > Online Projects to continue." ) );
    }

    // Back online: push anything edited while disconnected. The server dedups
    // by clientOpId, so re-sending an op it already has is a no-op.
    if( m_sync && COLLAB_SESSION::Get().IsLive() )
        m_sync->ReplayUnacked();
}


COLLAB_HISTORY_PANEL* SCH_COLLAB_TOOL::historyPanel()
{
    if( !m_frame )
        return nullptr;

    if( !m_historyPanel )
    {
        m_historyPanel = new COLLAB_HISTORY_PANEL( m_frame, m_frame );

        m_frame->GetAuiManager().AddPane(
                m_historyPanel, wxAuiPaneInfo()
                                        .Name( wxS( "CollabHistory" ) )
                                        .Caption( _( "History" ) )
                                        .Left()
                                        .Layer( 3 )
                                        .Position( 3 )
                                        .CloseButton( true )
                                        .MinSize( 240, 180 )
                                        .BestSize( 300, 240 )
                                        .Hide() );
    }

    m_historyPanel->SetProject( COLLAB_SESSION::Get().ProjectId() );

    return m_historyPanel;
}


int SCH_COLLAB_TOOL::ShowComments( const TOOL_EVENT& aEvent )
{
    wxString docId = currentDocId();

    if( docId.IsEmpty() )
    {
        m_frame->ShowInfoBarMsg(
                _( "Comments live on shared projects; start or join a session first." ) );
        return 0;
    }

    if( m_commentsDlg && m_commentsDlgDocId == docId )
    {
        m_commentsDlg->Raise();
        return 0;
    }

    if( m_commentsDlg )
    {
        m_commentsDlg->Destroy();
        m_commentsDlg = nullptr;
    }

    VECTOR2I anchorPos = m_frame->GetCanvas()->GetViewControls()->GetCursorPosition();

    m_commentsDlgDocId = docId;
    m_commentsDlg = new DIALOG_COLLAB_COMMENTS(
            m_frame, &m_commentsByDoc[ docId ], anchorPos,
            [this, docId, anchorPos]( const wxString& aBody, long long aParentId )
            {
                postComment( docId, aBody, aParentId, anchorPos );
            },
            [this]( long long aRootId, bool aResolved )
            {
                resolveComment( aRootId, aResolved );
            },
            [this]( const VECTOR2I& aPos )
            {
                m_frame->FocusOnLocation( aPos );
            } );

    m_commentsDlg->Bind( wxEVT_CLOSE_WINDOW,
                         [this]( wxCloseEvent& aClose )
                         {
                             m_commentsDlg = nullptr;
                             aClose.Skip();
                         } );

    m_commentsDlg->Bind( wxEVT_BUTTON,
                         [this]( wxCommandEvent& aCmd )
                         {
                             if( aCmd.GetId() == wxID_CANCEL && m_commentsDlg )
                             {
                                 DIALOG_COLLAB_COMMENTS* dlg = m_commentsDlg;
                                 m_commentsDlg = nullptr;
                                 dlg->Destroy();
                                 return;
                             }

                             aCmd.Skip();
                         } );

    m_commentsDlg->Show();
    return 0;
}


void SCH_COLLAB_TOOL::postComment( const wxString& aDocId, const wxString& aBody,
                                   long long aParentId, const VECTOR2I& aAnchor )
{
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string docId = aDocId.ToStdString( wxConvUTF8 );
    std::string body = aBody.ToStdString( wxConvUTF8 );
    long long   x = aAnchor.x;
    long long   y = aAnchor.y;

    COLLAB_SESSION::Get().RunAsync(
            [server, token, docId, body, aParentId, x, y]()
            {
                COLLAB_REST::CreateComment( wxString::FromUTF8( server ),
                                            wxString::FromUTF8( token ),
                                            wxString::FromUTF8( docId ),
                                            wxString::FromUTF8( body ), x, y, aParentId );
            } );
}


void SCH_COLLAB_TOOL::resolveComment( long long aRootId, bool aResolved )
{
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [server, token, aRootId, aResolved]()
            {
                COLLAB_REST::SetCommentResolved( wxString::FromUTF8( server ),
                                                 wxString::FromUTF8( token ), aRootId,
                                                 aResolved );
            } );
}


int SCH_COLLAB_TOOL::CopyShareLink( const TOOL_EVENT& aEvent )
{
    wxString projectId = COLLAB_SESSION::Get().ProjectId();

    if( projectId.IsEmpty() )
    {
        m_frame->ShowInfoBarMsg( _( "No collaboration session; start or join one first." ) );
        return 0;
    }

    // Repeat clicks copy instantly; the first mint happens on the worker and
    // can sit behind snapshot uploads for a few seconds.
    if( !m_cachedShareLink.IsEmpty() )
    {
        if( wxTheClipboard->Open() )
        {
            wxTheClipboard->SetData( new wxTextDataObject( m_cachedShareLink ) );
            wxTheClipboard->Close();
        }

        m_frame->ShowInfoBarMsg(
                _( "Share link copied to the clipboard." ) );
        return 0;
    }

    m_frame->ShowInfoBarMsg(
            _( "Creating a share link... it lands on the clipboard in a moment." ) );

    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, projectIdStd]()
            {
                std::optional<nlohmann::json> link = COLLAB_REST::CreateShareLink(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectIdStd ), wxS( "editor" ) );

                std::string url = link ? link->value( "url", "" ) : std::string();

                wxTheApp->CallAfter(
                        [this, alive, url]()
                        {
                            if( !*alive )
                                return;

                            if( url.empty() )
                            {
                                m_frame->ShowInfoBarError(
                                        _( "Could not create a share link (only project "
                                           "members can invite)." ) );
                                return;
                            }

                            if( wxTheClipboard->Open() )
                            {
                                wxTheClipboard->SetData(
                                        new wxTextDataObject( wxString::FromUTF8( url ) ) );
                                wxTheClipboard->Close();
                            }

                            m_frame->ShowInfoBarMsg(
                                    _( "Share link copied to the clipboard." ) );

                            m_cachedShareLink = wxString::FromUTF8( url );
                        } );
            } );

    return 0;
}


int SCH_COLLAB_TOOL::ShowHistory( const TOOL_EVENT& aEvent )
{
    COLLAB_HISTORY_PANEL* panel = historyPanel();

    if( !panel )
        return 0;

    wxAuiPaneInfo& pane = m_frame->GetAuiManager().GetPane( panel );
    pane.Show( !pane.IsShown() );
    m_frame->GetAuiManager().Update();

    if( pane.IsShown() )
        panel->RefreshHistory();

    return 0;
}


void SCH_COLLAB_TOOL::fetchComments()
{
    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );

    for( const auto& [path, docIdWx] : m_docIdByPath )
    {
        std::string docId = docIdWx.ToStdString( wxConvUTF8 );

        COLLAB_SESSION::Get().RunAsync(
                [this, alive, server, token, docId]()
                {
                    std::optional<nlohmann::json> listing = COLLAB_REST::ListComments(
                            wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                            wxString::FromUTF8( docId ) );

                    nlohmann::json comments = listing && listing->contains( "comments" )
                                                      ? ( *listing )[ "comments" ]
                                                      : nlohmann::json::array();

                    wxTheApp->CallAfter(
                            [this, alive, comments, docId]()
                            {
                                if( !*alive )
                                    return;

                                m_commentsByDoc[ wxString::FromUTF8( docId ) ] = comments;

                                if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                                {
                                    fprintf( stderr, "COLLAB sch comments: %zu loaded\n",
                                             (size_t) comments.size() );
                                }

                                rebuildCommentPins();
                            } );
                } );
    }
}


void SCH_COLLAB_TOOL::OnComment( const nlohmann::json& aMsg )
{
    wxString docId = wxString::FromUTF8( aMsg.value( "docId", "" ) );

    const nlohmann::json& payload =
            aMsg.contains( "comment" ) ? aMsg[ "comment" ] : nlohmann::json();

    if( docId.IsEmpty() || !payload.is_object() )
        return;

    std::string    action = payload.value( "action", "" );
    nlohmann::json entry = payload.contains( "comment" ) ? payload[ "comment" ]
                                                         : nlohmann::json();

    if( !entry.is_object() )
        return;

    nlohmann::json& comments = m_commentsByDoc[ docId ];

    if( !comments.is_array() )
        comments = nlohmann::json::array();

    long long id = jsonNumber( entry, "id", -1 );

    if( action == "deleted" )
    {
        nlohmann::json kept = nlohmann::json::array();

        for( const nlohmann::json& c : comments )
        {
            if( jsonNumber( c, "id", -1 ) != id && jsonNumber( c, "parentId", -1 ) != id )
                kept.push_back( c );
        }

        comments = std::move( kept );
    }
    else if( action == "updated" )
    {
        for( nlohmann::json& c : comments )
        {
            if( jsonNumber( c, "id", -1 ) == id )
                c = entry;
        }
    }
    else if( action == "added" )
    {
        bool present = false;

        for( const nlohmann::json& c : comments )
            present |= jsonNumber( c, "id", -1 ) == id;

        if( !present )
            comments.push_back( entry );
    }

    if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        fprintf( stderr, "COLLAB sch comment %s: id=%lld\n", action.c_str(), id );

    rebuildCommentPins();

    if( m_commentsDlg && m_commentsDlgDocId == docId )
        m_commentsDlg->Reload();
}


void SCH_COLLAB_TOOL::rebuildCommentPins()
{
    std::vector<COMMENT_PIN> pins;
    wxString                 docId = currentDocId();

    auto it = m_commentsByDoc.find( docId );

    if( it != m_commentsByDoc.end() )
    {
        for( const nlohmann::json& c : it->second )
        {
            if( !c.is_object() || jsonNumber( c, "parentId", -1 ) >= 0 )
                continue;

            COMMENT_PIN pin;
            pin.pos = VECTOR2I( jsonNumber( c, "x", 0 ), jsonNumber( c, "y", 0 ) );
            pin.resolved = c.value( "resolved", false );

            long long id = jsonNumber( c, "id", -1 );
            pin.count = 0;

            for( const nlohmann::json& other : it->second )
            {
                if( jsonNumber( other, "id", -1 ) == id
                    || jsonNumber( other, "parentId", -1 ) == id )
                {
                    pin.count++;
                }
            }

            pins.push_back( pin );
        }
    }

    m_cursorItem.SetCommentPins( std::move( pins ) );

    if( KIGFX::VIEW* view = getView() )
    {
        view->Update( &m_cursorItem );

        if( m_frame->GetCanvas() )
            m_frame->GetCanvas()->Refresh();
    }
}


void SCH_COLLAB_TOOL::rebuildOverlay()
{
    KIGFX::VIEW* view = getView();

    if( !view || !m_frame )
        return;

    std::vector<REMOTE_PEER_DRAW> draws;

    std::set<KIID>                ghostedNow;
    wxString                      docId = currentDocId();
    wxString                      sheetFile = currentSheetFile();

    if( !docId.IsEmpty() )
    {
        for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( docId ) )
        {
            if( !peer.state.is_object() )
                continue;

            // A peer only renders on the sheet they are actually looking at.
            if( wxString::FromUTF8( peer.state.value( "sheetFile", "" ) ) != sheetFile )
                continue;

            REMOTE_PEER_DRAW draw;
            draw.label = peer.name.IsEmpty() ? peer.login : peer.name;
            draw.color = COLLAB_CURSOR_ITEM::ParsePeerColor( peer.color );

            if( peer.state.contains( "cursor" ) && peer.state[ "cursor" ].is_array()
                && peer.state[ "cursor" ].size() >= 2 )
            {
                draw.cursor = VECTOR2I( peer.state[ "cursor" ][ 0 ].get<int>(),
                                        peer.state[ "cursor" ][ 1 ].get<int>() );
                draw.hasCursor = true;
            }

            // Prefer the sender's own geometry (live during their drags); fall
            // back to resolving ids locally for peers on an older client.
            if( peer.state.contains( "boxes" ) && peer.state[ "boxes" ].is_array() )
            {
                for( const nlohmann::json& box : peer.state[ "boxes" ] )
                {
                    if( !box.is_array() || box.size() < 4 )
                        continue;

                    draw.selectionBoxes.emplace_back(
                            VECTOR2I( box[ 0 ].get<int>(), box[ 1 ].get<int>() ),
                            VECTOR2I( box[ 2 ].get<int>(), box[ 3 ].get<int>() ) );
                }

                // When we hold our own copy of a dragged item, render the real
                // thing at the peer's live position instead of an empty box.
                if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
                {
                    const nlohmann::json& ids = peer.state[ "selection" ];
                    const nlohmann::json& boxes = peer.state[ "boxes" ];
                    SCH_SCREEN*           screen = m_frame->GetScreen();

                    for( size_t ii = 0; ii < ids.size() && ii < boxes.size()
                                        && draw.ghostItems.size() < MAX_GHOST_ITEMS; ++ii )
                    {
                        if( !ids[ ii ].is_string() || !boxes[ ii ].is_array()
                            || boxes[ ii ].size() < 4 )
                            continue;

                        KIID kiid( wxString::FromUTF8( ids[ ii ].get<std::string>() ) );
                        SCH_ITEM* item = m_frame->Schematic().ResolveItem( kiid, nullptr, true );

                        if( !item || item->GetParent() != screen )
                            continue;

                        VECTOR2I offset( boxes[ ii ][ 0 ].get<int>()
                                                 - item->GetBoundingBox().GetX(),
                                         boxes[ ii ][ 1 ].get<int>()
                                                 - item->GetBoundingBox().GetY() );

                        // Only ghost items that are actually displaced (i.e. mid-drag).
                        if( std::abs( offset.x ) > 1 || std::abs( offset.y ) > 1 )
                        {
                            draw.ghostItems.push_back( { item, offset } );
                            ghostedNow.insert( item->m_Uuid );
                        }
                    }
                }
            }
            else if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
            {
                for( const nlohmann::json& id : peer.state[ "selection" ] )
                {
                    if( !id.is_string() )
                        continue;

                    KIID kiid( wxString::FromUTF8( id.get<std::string>() ) );

                    if( SCH_ITEM* item = m_frame->Schematic().ResolveItem( kiid, nullptr, true ) )
                        draw.selectionBoxes.push_back( item->GetBoundingBox() );
                }
            }

            // In-flight wire/bus segments the peer is drawing right now.
            if( peer.state.contains( "ghost" ) && peer.state[ "ghost" ].is_array() )
            {
                for( const nlohmann::json& seg : peer.state[ "ghost" ] )
                {
                    if( !seg.is_array() || seg.size() < 5 )
                        continue;

                    draw.ghostSegs.push_back( { VECTOR2I( seg[ 0 ].get<int>(),
                                                          seg[ 1 ].get<int>() ),
                                                VECTOR2I( seg[ 2 ].get<int>(),
                                                          seg[ 3 ].get<int>() ),
                                                seg[ 4 ].get<int>() } );
                }
            }

            if( draw.hasCursor || !draw.selectionBoxes.empty() || !draw.ghostSegs.empty()
                || !draw.ghostItems.empty() )
            {
                draws.push_back( std::move( draw ) );
            }
        }
    }

    // Hide the stationary original while a peer's live-drag ghost replaces
    // it; restore the moment the ghost clears.
    for( const KIID& id : ghostedNow )
    {
        if( m_ghostHidden.insert( id ).second )
        {
            if( SCH_ITEM* item = m_frame->Schematic().ResolveItem( id, nullptr, true ) )
                view->Hide( item, true );
        }
    }

    for( auto it = m_ghostHidden.begin(); it != m_ghostHidden.end(); )
    {
        if( ghostedNow.count( *it ) )
        {
            ++it;
            continue;
        }

        if( SCH_ITEM* item = m_frame->Schematic().ResolveItem( *it, nullptr, true ) )
        {
            view->Hide( item, false );
            view->Update( item );
        }

        it = m_ghostHidden.erase( it );
    }

    m_cursorItem.SetPeers( std::move( draws ) );
    rebuildCommentPins();

    // The sch view is rebuilt wholesale on sheet changes, silently dropping our
    // item, so re-add it every time; Remove() is a no-op when it is not in the view.
    view->Remove( &m_cursorItem );
    view->Add( &m_cursorItem );
    view->Update( &m_cursorItem );

    if( m_frame->GetCanvas() )
        m_frame->GetCanvas()->Refresh();
}


void SCH_COLLAB_TOOL::setTransitions()
{
    Go( &SCH_COLLAB_TOOL::StartSession,      SCH_ACTIONS::collabStartSession.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::JoinSession,       SCH_ACTIONS::collabJoinSession.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::LeaveSession,      SCH_ACTIONS::collabLeaveSession.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::ShowHistory,       SCH_ACTIONS::collabHistory.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::CopyShareLink,     SCH_ACTIONS::collabCopyLink.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::ShowComments,      SCH_ACTIONS::collabComments.MakeEvent() );
    Go( &SCH_COLLAB_TOOL::FollowNextPeer,    SCH_ACTIONS::collabFollow.MakeEvent() );

    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::PointSelectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::SelectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::UnselectedEvent );
    Go( &SCH_COLLAB_TOOL::onSelectionChange, EVENTS::ClearedEvent );
}
