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

#include <collab/collab_journal.h>

#include <wx/dir.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/textfile.h>

static const wxChar* const traceCollab = wxT( "COLLAB" );

/// Rewrite the file once acked lines outnumber this.
static constexpr size_t STALE_LIMIT = 1000;


void COLLAB_JOURNAL::Open( const wxString& aProjectPath, const wxString& aProjectName )
{
    Close();

    if( aProjectPath.IsEmpty() )
        return;

    wxFileName dir( aProjectPath, wxEmptyString );
    dir.AppendDir( aProjectName + wxS( ".collab" ) );

    if( !dir.DirExists() && !dir.Mkdir( wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        wxLogTrace( traceCollab, wxS( "cannot create journal dir %s" ), dir.GetPath() );
        return;
    }

    wxFileName file( dir.GetPath(), wxS( "oplog.ndjson" ) );
    m_path = file.GetFullPath();

    load();
}


void COLLAB_JOURNAL::Close()
{
    m_path.Clear();
    m_pending.clear();
    m_staleLines = 0;
}


void COLLAB_JOURNAL::load()
{
    m_pending.clear();
    m_staleLines = 0;

    if( !wxFileName::FileExists( m_path ) )
        return;

    wxTextFile file( m_path );

    if( !file.Open() )
    {
        wxLogTrace( traceCollab, wxS( "cannot read journal %s" ), m_path );
        return;
    }

    for( wxString line = file.GetFirstLine(); !file.Eof(); line = file.GetNextLine() )
    {
        if( line.IsEmpty() )
            continue;

        try
        {
            nlohmann::json entry = nlohmann::json::parse( line.ToStdString( wxConvUTF8 ) );

            // "acked" markers are appended rather than rewriting the file every time.
            if( entry.value( "acked", false ) )
            {
                wxString clientOpId = wxString::FromUTF8( entry.value( "clientOpId", "" ) );

                std::erase_if( m_pending,
                               [&]( const ENTRY& e )
                               {
                                   return e.clientOpId == clientOpId;
                               } );
                m_staleLines++;
                continue;
            }

            ENTRY e;
            e.docId = wxString::FromUTF8( entry.value( "docId", "" ) );
            e.clientOpId = wxString::FromUTF8( entry.value( "clientOpId", "" ) );
            e.changes = entry.value( "changes", nlohmann::json::array() );

            if( !e.docId.IsEmpty() && !e.clientOpId.IsEmpty() )
                m_pending.push_back( std::move( e ) );
        }
        catch( const std::exception& exc )
        {
            wxLogTrace( traceCollab, wxS( "skipping bad journal line: %s" ), exc.what() );
            m_staleLines++;
        }
    }

    file.Close();

    if( m_staleLines > STALE_LIMIT )
        rewrite();
}


void COLLAB_JOURNAL::Append( const wxString& aDocId, const wxString& aClientOpId,
                             const nlohmann::json& aChanges )
{
    ENTRY entry;
    entry.docId = aDocId;
    entry.clientOpId = aClientOpId;
    entry.changes = aChanges;
    m_pending.push_back( entry );

    if( m_path.IsEmpty() )
        return;

    nlohmann::json line = {
        { "docId", aDocId.ToStdString( wxConvUTF8 ) },
        { "clientOpId", aClientOpId.ToStdString( wxConvUTF8 ) },
        { "changes", aChanges },
    };

    wxFFile file( m_path, wxS( "ab" ) );

    if( file.IsOpened() )
    {
        file.Write( wxString::FromUTF8( line.dump() ) + wxS( "\n" ) );
        file.Close();
    }
}


void COLLAB_JOURNAL::Ack( const wxString& aClientOpId )
{
    const size_t before = m_pending.size();

    std::erase_if( m_pending,
                   [&]( const ENTRY& e )
                   {
                       return e.clientOpId == aClientOpId;
                   } );

    if( m_pending.size() == before || m_path.IsEmpty() )
        return;

    m_staleLines++;

    if( m_staleLines > STALE_LIMIT )
    {
        rewrite();
        return;
    }

    nlohmann::json line = {
        { "clientOpId", aClientOpId.ToStdString( wxConvUTF8 ) },
        { "acked", true },
    };

    wxFFile file( m_path, wxS( "ab" ) );

    if( file.IsOpened() )
    {
        file.Write( wxString::FromUTF8( line.dump() ) + wxS( "\n" ) );
        file.Close();
    }
}


void COLLAB_JOURNAL::Clear()
{
    m_pending.clear();
    m_staleLines = 0;

    if( !m_path.IsEmpty() )
        rewrite();
}


void COLLAB_JOURNAL::rewrite()
{
    if( m_path.IsEmpty() )
        return;

    // Write beside the journal and swap, so a crash mid-write can't lose the
    // ops we still owe the server.
    wxString tmpPath = m_path + wxS( ".tmp" );
    wxFFile  tmp( tmpPath, wxS( "wb" ) );

    if( !tmp.IsOpened() )
        return;

    for( const ENTRY& e : m_pending )
    {
        nlohmann::json line = {
            { "docId", e.docId.ToStdString( wxConvUTF8 ) },
            { "clientOpId", e.clientOpId.ToStdString( wxConvUTF8 ) },
            { "changes", e.changes },
        };

        tmp.Write( wxString::FromUTF8( line.dump() ) + wxS( "\n" ) );
    }

    tmp.Close();

    if( wxFileName::FileExists( m_path ) )
        wxRemoveFile( m_path );

    wxRenameFile( tmpPath, m_path );
    m_staleLines = 0;
}
