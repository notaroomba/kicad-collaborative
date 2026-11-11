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

#include <collab/collab_outbox.h>

#include <algorithm>

#include <wx/filefn.h>
#include <wx/filename.h>


void COLLAB_OUTBOX::Push( const wxString& aDocId, const wxString& aClientOpId,
                          nlohmann::json aChanges )
{
    std::set<std::string> refilled;

    if( aChanges.is_array() )
    {
        for( const nlohmann::json& change : aChanges )
        {
            if( change.is_object() && change.value( "zoneFill", false ) )
                refilled.insert( change.value( "id", "" ) );
        }
    }

    if( !refilled.empty() )
    {
        for( OP& op : m_ops )
        {
            if( op.sent || op.docId != aDocId || !op.changes.is_array() )
                continue;

            for( auto it = op.changes.begin(); it != op.changes.end(); )
            {
                if( it->is_object() && it->value( "zoneFill", false )
                    && refilled.count( it->value( "id", "" ) ) )
                {
                    it = op.changes.erase( it );
                }
                else
                {
                    ++it;
                }
            }
        }

        std::erase_if( m_ops,
                       []( const OP& aOp )
                       {
                           return !aOp.sent && aOp.changes.is_array() && aOp.changes.empty();
                       } );
    }

    OP op;
    op.clientOpId = aClientOpId;
    op.docId = aDocId;
    op.changes = std::move( aChanges );
    m_ops.push_back( std::move( op ) );
}


size_t COLLAB_OUTBOX::Pump( const std::function<bool( const OP& )>& aSend )
{
    size_t inFlight = 0;

    for( const OP& op : m_ops )
    {
        if( op.sent )
            inFlight++;
    }

    size_t             sentNow = 0;
    std::set<wxString> held;

    for( OP& op : m_ops )
    {
        if( inFlight >= WINDOW )
            break;

        if( op.sent || held.count( op.docId ) )
            continue;

        if( aSend( op ) )
        {
            op.sent = true;
            inFlight++;
            sentNow++;
        }
        else
        {
            held.insert( op.docId );
        }
    }

    return sentNow;
}


bool COLLAB_OUTBOX::Ack( const wxString& aClientOpId, OP* aOut )
{
    auto it = std::find_if( m_ops.begin(), m_ops.end(),
                            [&]( const OP& aOp )
                            {
                                return aOp.clientOpId == aClientOpId;
                            } );

    if( it == m_ops.end() )
        return false;

    if( aOut )
        *aOut = std::move( *it );

    m_ops.erase( it );
    return true;
}


void COLLAB_OUTBOX::MarkAllUnsent()
{
    for( OP& op : m_ops )
        op.sent = false;
}


std::vector<COLLAB_OUTBOX::OP> COLLAB_OUTBOX::TakeUnsent( const wxString& aDocId )
{
    std::vector<OP> taken;

    for( auto it = m_ops.begin(); it != m_ops.end(); )
    {
        if( !it->sent && it->docId == aDocId )
        {
            taken.push_back( std::move( *it ) );
            it = m_ops.erase( it );
        }
        else
        {
            ++it;
        }
    }

    return taken;
}


void COLLAB_OUTBOX::Clear( const wxString& aDocId )
{
    if( aDocId.IsEmpty() )
    {
        m_ops.clear();
        return;
    }

    std::erase_if( m_ops,
                   [&]( const OP& aOp )
                   {
                       return aOp.docId == aDocId;
                   } );
}


size_t COLLAB_OUTBOX::UnsentCount() const
{
    return std::count_if( m_ops.begin(), m_ops.end(),
                          []( const OP& aOp )
                          {
                              return !aOp.sent;
                          } );
}


size_t COLLAB_OUTBOX::Count( const wxString& aDocId ) const
{
    return std::count_if( m_ops.begin(), m_ops.end(),
                          [&]( const OP& aOp )
                          {
                              return aOp.docId == aDocId;
                          } );
}


std::set<std::string> COLLAB_OUTBOX::TouchedIds( const wxString& aDocId ) const
{
    std::set<std::string> ids;

    for( const OP& op : m_ops )
    {
        if( op.docId != aDocId || !op.changes.is_array() )
            continue;

        for( const nlohmann::json& change : op.changes )
        {
            if( change.is_object() )
                ids.insert( change.value( "id", "" ) );
        }
    }

    return ids;
}


void COLLAB_OUTBOX::RemoveLegacyJournal( const wxString& aProjectPath,
                                         const wxString& aProjectName,
                                         const wxString& aFileName )
{
    if( aProjectPath.IsEmpty() )
        return;

    wxFileName file( aProjectPath, aFileName );
    file.AppendDir( aProjectName + wxS( ".collab" ) );

    if( file.FileExists() )
        wxRemoveFile( file.GetFullPath() );

    if( wxFileName::FileExists( file.GetFullPath() + wxS( ".tmp" ) ) )
        wxRemoveFile( file.GetFullPath() + wxS( ".tmp" ) );
}
